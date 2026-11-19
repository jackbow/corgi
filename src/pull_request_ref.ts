//! GitHub PR identity shared by daemon, viewer and browser projections.
export interface Ref {
  repo: string;
  number: number;
  url: string;
}
export function parse(value: string): Ref | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password)
      return null;
    const match = /^\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
    return { repo: match[1], number: Number(match[2]), url: `https://github.com/${match[1]}/pull/${match[2]}` };
  } catch {
    return null;
  }
}
