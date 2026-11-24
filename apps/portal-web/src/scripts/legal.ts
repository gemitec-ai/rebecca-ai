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
    if (data && data.contactEmail) {
      const emailText = document.getElementById('contact-email-text');
      const emailNote = document.getElementById('contact-email-note');

      if (emailText) {
        emailText.textContent = formatObfuscatedSupportEmail(data.contactEmail);
        emailText.style.display = 'inline';
      }
      if (emailNote) emailNote.style.display = 'block';
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
