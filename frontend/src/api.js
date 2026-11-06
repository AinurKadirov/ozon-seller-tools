const API = '';

export async function fetchCards(params) {
  const query = new URLSearchParams(params);
  const res = await fetch(`${API}/api/cards?${query}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runSync(minDate, maxDate) {
  const res = await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minDate, maxDate }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
