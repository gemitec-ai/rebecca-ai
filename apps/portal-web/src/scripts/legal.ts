import { PublicSupportPlansResponse } from '@rebecca/types';
import { formatObfuscatedSupportEmail } from '../utils/contactEmail';

/**
 * Progressively enhances the static build-time contact email on `/legal`
 * if the backend support config returns an authoritative address.
 */
export async function loadLegalContactEmail(): Promise<void> {
  try {
    const res = await fetch('/api/v1/support/plans');
    if (!res.ok) return;

    const data: PublicSupportPlansResponse = await res.json();
    const formattedEmail = data && data.contactEmail ? formatObfuscatedSupportEmail(data.contactEmail) : '';
    if (formattedEmail) {
      const emailText = document.getElementById('contact-email-text');
      const emailNote = document.getElementById('contact-email-note');
      const emailFallback = document.getElementById('contact-email-fallback');

      if (emailText) {
        emailText.textContent = formattedEmail;
        emailText.style.display = 'inline';
      }
      if (emailNote) emailNote.style.display = 'block';
      if (emailFallback) emailFallback.style.display = 'none';
    }
  } catch (err) {
    console.warn('[Legal] Failed to load contact email:', err);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadLegalContactEmail().catch(console.error);
  });
}
