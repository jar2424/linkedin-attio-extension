// popup.js — orchestrates the popup UI and Attio API calls

const ATTIO_BASE = 'https://api.attio.com/v2';

// ── Storage helpers ───────────────────────────────────────────────────────────

function getApiKey() {
  return new Promise(resolve =>
    chrome.storage.local.get(['apiKey'], r => resolve(r.apiKey || ''))
  );
}

function saveApiKey(key) {
  return new Promise(resolve =>
    chrome.storage.local.set({ apiKey: key }, resolve)
  );
}

// ── Attio API ─────────────────────────────────────────────────────────────────

async function attioFetch(path, options = {}) {
  const apiKey = await getApiKey();
  const res = await fetch(`${ATTIO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.message || body.error || msg;
    } catch (_) { /* ignore parse errors */ }
    throw new Error(msg);
  }

  return res.json();
}

/**
 * Search Attio for a person by LinkedIn URL first, then fall back to name.
 * Returns the first matching record object, or null.
 */
async function findPersonByLinkedIn(profileUrl, fullName) {
  // Try LinkedIn URL match first
  try {
    const data = await attioFetch('/objects/people/records/query', {
      method: 'POST',
      body: JSON.stringify({ filter: { linkedin: { '$eq': profileUrl } } }),
    });
    if (data.data && data.data.length > 0) return data.data[0];
  } catch (_) { /* fall through to name search */ }

  // Fall back to name match
  if (fullName) {
    const data = await attioFetch('/objects/people/records/query', {
      method: 'POST',
      body: JSON.stringify({ filter: { name: { '$eq': fullName } } }),
    });
    if (data.data && data.data.length > 0) return data.data[0];
  }

  return null;
}

/**
 * Create a new person record in Attio.
 * Returns the created record object.
 */
async function createPerson({ firstName, lastName, fullName, headline, profileUrl }) {
  const values = {
    name: [{ first_name: firstName, last_name: lastName, full_name: fullName }],
  };

  if (headline) {
    values.job_title = [{ value: headline }];
  }

  if (profileUrl) {
    values.linkedin = [{ value: profileUrl }];
  }

  const data = await attioFetch('/objects/people/records', {
    method: 'POST',
    body: JSON.stringify({ data: { values } }),
  });
  return data.data;
}

/**
 * Fetch all lists (pipelines) from the workspace.
 */
async function getLists() {
  const data = await attioFetch('/lists');
  return data.data || [];
}

/**
 * Add an existing person record to a list (pipeline).
 */
async function addToList(listId, recordId) {
  return attioFetch(`/lists/${listId}/entries`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        parent_object: 'people',
        parent_record_id: recordId,
        entry_values: {},
      },
    }),
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function show(id)   { document.getElementById(id).classList.remove('hidden'); }
function hide(id)   { document.getElementById(id).classList.add('hidden'); }
function setText(id, text) { document.getElementById(id).textContent = text; }

function showLoading() {
  hide('not-linkedin');
  hide('profile-view');
  hide('no-api-key');
  hide('error-msg');
  hide('success-msg');
  show('loading');
}

function showError(msg) {
  hide('loading');
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Main flow ─────────────────────────────────────────────────────────────────

let currentProfile = null;   // data from content script
let existingRecord = null;   // Attio record if person already exists

async function init() {
  const apiKey = await getApiKey();

  // Get the active LinkedIn tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isLinkedIn = tab && tab.url && tab.url.includes('linkedin.com/in/');

  if (!isLinkedIn) {
    hide('loading');
    show('not-linkedin');
    return;
  }

  if (!apiKey) {
    hide('loading');
    show('no-api-key');
    return;
  }

  showLoading();

  // Inject extraction function directly into the page — works even after SPA navigation
  let profile;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const nameEl =
          document.querySelector('h1.text-heading-xlarge') ||
          document.querySelector('h1[class*="heading"]') ||
          document.querySelector('h1');
        const headlineEl =
          document.querySelector('.text-body-medium.break-words') ||
          document.querySelector('[data-generated-suggestion-target]');
        const fullName = nameEl ? nameEl.textContent.trim() : '';
        const nameParts = fullName.trim().split(/\s+/);
        return {
          isProfilePage: window.location.pathname.startsWith('/in/'),
          fullName,
          firstName: nameParts[0] || '',
          lastName: nameParts.slice(1).join(' ') || '',
          headline: headlineEl ? headlineEl.textContent.trim() : '',
          profileUrl: window.location.href.split('?')[0].replace(/\/$/, ''),
        };
      },
    });
    profile = results[0]?.result;
  } catch (err) {
    showError('Could not read LinkedIn profile. Try reloading the page.');
    return;
  }

  if (!profile || !profile.isProfilePage) {
    hide('loading');
    show('not-linkedin');
    return;
  }

  currentProfile = profile;

  // Populate the profile card
  setText('profile-name', profile.fullName || '(no name)');
  setText('profile-headline', profile.headline || '');
  setText('profile-url', profile.profileUrl || '');

  // Run both API calls in parallel to reduce loading time
  const [listsResult, foundResult] = await Promise.allSettled([
    getLists(),
    findPersonByLinkedIn(profile.profileUrl, profile.fullName),
  ]);

  // Populate pipeline dropdown
  if (listsResult.status === 'fulfilled') {
    const sel = document.getElementById('pipeline-select');
    listsResult.value.forEach(list => {
      const parents = list.parent_object || [];
      if (parents.length > 0 && !parents.includes('people')) return;
      const opt = document.createElement('option');
      opt.value = list.id?.list_id || list.id;
      opt.textContent = list.name || list.title || opt.value;
      sel.appendChild(opt);
    });
  } else {
    const sel = document.getElementById('pipeline-select');
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '⚠ Missing list_configuration:read scope';
    opt.disabled = true;
    sel.appendChild(opt);
  }

  const found = foundResult.status === 'fulfilled' ? foundResult.value : null;

  hide('loading');
  show('profile-view');
  show('attio-status');

  const badge = document.getElementById('status-badge');
  const attioLink = document.getElementById('attio-link');

  if (found) {
    existingRecord = found;
    badge.textContent = 'Already in Attio';
    badge.className = 'exists';

    attioLink.href = 'https://app.attio.com';
    show('attio-link');

    // Still show the pipeline section so they can add to another list
    show('add-section');
    document.getElementById('add-btn').textContent = 'Add to Pipeline';
  } else {
    existingRecord = null;
    badge.textContent = 'Not in Attio yet';
    badge.className = 'not-found';
    show('add-section');
  }
}

// ── Event: Add to Attio ───────────────────────────────────────────────────────

document.getElementById('add-btn').addEventListener('click', async () => {
  const btn = document.getElementById('add-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  hide('error-msg');
  hide('success-msg');

  try {
    let record = existingRecord;

    // Create the person if they don't exist yet
    if (!record) {
      record = await createPerson(currentProfile);
    }

    const recordId = record.id?.record_id || record.id;
    if (!recordId || typeof recordId !== 'string') {
      throw new Error(`Could not resolve record ID (got: ${JSON.stringify(record.id)})`);
    }

    // Optionally add to a pipeline
    const listId = document.getElementById('pipeline-select').value;
    if (listId) {
      try {
        await addToList(listId, recordId);
      } catch (listErr) {
        throw new Error(`List error (listId: ${listId}, recordId: ${recordId}): ${listErr.message}`);
      }
    }

    // Show success
    hide('add-section');
    const successEl = document.getElementById('success-msg');
    successEl.textContent = listId
      ? '✓ Added to Attio and pipeline!'
      : '✓ Added to Attio!';
    successEl.classList.remove('hidden');

    // Update status badge
    const badge = document.getElementById('status-badge');
    badge.textContent = 'In Attio';
    badge.className = 'exists';

    const attioLink = document.getElementById('attio-link');
    attioLink.href = 'https://app.attio.com';
    show('attio-link');

    existingRecord = record;
  } catch (err) {
    showError(err.message || 'Something went wrong. Check your API key and permissions.');
    btn.disabled = false;
    btn.textContent = existingRecord ? 'Add to Pipeline' : 'Add to Attio';
  }
});

// ── Event: Settings toggle ────────────────────────────────────────────────────

document.getElementById('settings-btn').addEventListener('click', () => {
  hide('main-view');
  show('settings-view');
  // Pre-fill the input if a key is already saved
  getApiKey().then(k => {
    if (k) document.getElementById('api-key-input').value = k;
  });
});

document.getElementById('back-btn').addEventListener('click', () => {
  hide('settings-view');
  show('main-view');
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  await saveApiKey(key);
  const status = document.getElementById('save-status');
  status.textContent = 'Saved!';
  status.classList.remove('hidden');
  setTimeout(() => {
    status.classList.add('hidden');
    hide('settings-view');
    show('main-view');
    // Re-run init now that we have a key
    showLoading();
    init();
  }, 700);
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

showLoading();
init();
