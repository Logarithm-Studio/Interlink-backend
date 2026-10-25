/** Mentioned connected apps get first access to the bounded agent tool budget. */
export function orderConnectedToolkits(connected: string[], preferred: string[], message: string): string[] {
  const words = message.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const mentioned = connected.filter((slug) => {
    const label = slug.replace(/_/g, " ");
    return (` ${words} `).includes(` ${label} `);
  });
  const priority = [...new Set([...mentioned, ...preferred])];
  return [...new Set(connected)].sort((a, b) => {
    const rank = (slug: string) => { const index = priority.indexOf(slug); return index < 0 ? priority.length : index; };
    return rank(a) - rank(b);
  });
}
