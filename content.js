// content.js - Runs on LinkedIn profile pages and extracts profile data

function extractProfileData() {
  const isProfilePage = window.location.pathname.startsWith('/in/');

  if (!isProfilePage) {
    return { isProfilePage: false };
  }

  // Name — LinkedIn renders this in an h1; try specific class first, then fallback
  const nameEl =
    document.querySelector('h1.text-heading-xlarge') ||
    document.querySelector('h1[class*="heading"]') ||
    document.querySelector('.pv-text-details__left-panel h1') ||
    document.querySelector('h1');

  const fullName = nameEl ? nameEl.textContent.trim() : '';

  // Headline — the tagline/job title shown below the name
  const headlineEl =
    document.querySelector('.text-body-medium.break-words') ||
    document.querySelector('[data-generated-suggestion-target]') ||
    document.querySelector('.pv-text-details__left-panel .text-body-medium');

  const headline = headlineEl ? headlineEl.textContent.trim() : '';

  // Profile URL — strip query params and trailing slash for a canonical form
  const profileUrl = window.location.href
    .split('?')[0]
    .replace(/\/$/, '');

  // Split name into first/last (best-effort)
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  return {
    isProfilePage: true,
    fullName,
    firstName,
    lastName,
    headline,
    profileUrl,
  };
}

// Respond to messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getProfileData') {
    sendResponse(extractProfileData());
  }
  return true; // keep the message channel open for async responses
});
