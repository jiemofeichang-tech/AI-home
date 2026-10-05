import CommunityApp from '@/components/community-app';
import { Suspense } from 'react';
export default function Page(){return <Suspense fallback={<div className="loading">正在加载…</div>}><CommunityApp/></Suspense>;}
