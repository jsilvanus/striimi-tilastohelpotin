const API_URL = 'https://api.brevo.com/v3/smtp/email';

export function createMailer({ apiKey, fetchImpl = fetch }) {
  return {
    async send({ sender, to, subject, text }) {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: to }],
          subject,
          textContent: text,
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`Brevo send failed with ${res.status}: ${body}`);
      }
      return res.json();
    },
  };
}
