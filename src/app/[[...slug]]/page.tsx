import CommunityApp from '@/components/community-app';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { loginUrl,requiresPostLogin } from '@/shared/login-navigation';

export default async function Page({params,searchParams}:{params:Promise<{slug?:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {slug=[]}=await params;
  const path=`/${slug.map(encodeURIComponent).join('/')}`;
  if(requiresPostLogin(path)) {
    const session=await auth.api.getSession({headers:await headers()});
    if(!session) {
      const query=new URLSearchParams();
      for(const [name,value] of Object.entries(await searchParams)) {
        for(const item of Array.isArray(value)?value:value===undefined?[]:[value]) query.append(name,item);
      }
      redirect(loginUrl(path+(query.size?`?${query}`:'')));
    }
  }
  return <Suspense fallback={<div className="loading">正在加载…</div>}><CommunityApp/></Suspense>;
}
