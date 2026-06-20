export function countThemePapers<T>(themes: Map<string, T[]>): number {
  return Array.from(themes.values()).reduce((sum, papers) => sum + papers.length, 0);
}
