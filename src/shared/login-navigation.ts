/** Pages that display posts must have a live session before rendering. */
export function requiresPostLogin(path:string) {
  const [section,id]=path.split('/').filter(Boolean);
  return !section || ['home','posts','discover','profile'].includes(section) || (section==='communities' && !!id);
}

/** Keep login return destinations on this site and avoid login/consent loops. */
export function loginReturnPath(value:string|null|undefined) {
  if(!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  const destination=new URL(value,'https://community.invalid');
  if(destination.origin!=='https://community.invalid' || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(destination.pathname)) return '/';
  if(/^\/(?:login|consent)(?:\/|$)/.test(destination.pathname)) return '/';
  return destination.pathname+destination.search+destination.hash;
}

export function loginUrl(path:string) {
  return `/login?returnTo=${encodeURIComponent(loginReturnPath(path))}`;
}
