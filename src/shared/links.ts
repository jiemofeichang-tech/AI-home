const closingBrackets: Record<string,string> = {
  ')':'(', ']':'[', '}':'{', '）':'（', '】':'【', '》':'《', '〉':'〈', '〕':'〔'
};
const openingBrackets = new Set(Object.values(closingBrackets));
const trailingPunctuation = /[.,!?;:'，。！？；：、…]+$/u;

function trimLink(candidate: string): string {
  const depth: Record<string,number> = {};
  for(let index=0;index<candidate.length;index++) {
    const character=candidate[index];
    if(openingBrackets.has(character))depth[character]=(depth[character]||0)+1;
    const opening=closingBrackets[character];
    if(opening) {
      // A closing wrapper belongs to the surrounding prose, while pairs inside
      // a URL (including an IPv6 host) remain part of the URL.
      if(!depth[opening])return candidate.slice(0,index).replace(trailingPunctuation,'');
      depth[opening]--;
    }
  }
  return candidate.replace(trailingPunctuation,'');
}

/** Extract web links from pasted share text without fetching or truncating them. */
export function extractWebUrls(text: string): string[] {
  const links:string[]=[];
  const seen=new Set<string>();
  const candidates=/(?<![A-Za-z0-9_+./-])https?:\/\/[^\s<>"“”‘’«»「」『』，。！？；：、…]+/giu;
  for(const match of text.matchAll(candidates)) {
    const candidate=trimLink(match[0]);
    // URL() tolerates missing authorities and backslashes; pasted links must
    // contain an explicit authority and use normal URL separators.
    if(!/^https?:\/\/[^/\\?#]/i.test(candidate)||candidate.includes('\\'))continue;
    try {
      const url=new URL(candidate);
      if(!['http:','https:'].includes(url.protocol)||!url.hostname||seen.has(url.href))continue;
      seen.add(url.href);
      links.push(candidate);
    } catch {
      // Ignore malformed candidates and continue collecting the other links.
    }
  }
  return links;
}
/** Only explicit authentication destinations count, never article text or query values. */
export function isLoginPageUrl(value:unknown):boolean {
  if(typeof value!=='string')return false;
  try {
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)&&/^\/(?:auth\/|accounts?\/|users?\/|sessions?\/)?(?:login|signin|sign-in)\/?$/i.test(url.pathname);
  } catch {return false;}
}
