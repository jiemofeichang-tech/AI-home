'use client';
import { useCallback,useEffect,useRef } from 'react';
import { useRouter,useSearchParams } from 'next/navigation';
import { readSearchPosition,readSearchState,replaceSearchQuery,searchHref,searchReturnHref,type SearchState } from '@/shared/search-navigation';

const positionKey='community.search.positions.v1',viewerKey='community.search.viewer.v1';
function positions():Record<string,unknown> {try{const value=JSON.parse(sessionStorage.getItem(positionKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
function savePosition(href:string,viewer:string,y:number) {
  try {const current=positions();current[href]={href,viewer,y:Math.max(0,y),savedAt:Date.now()};
    const entries=Object.entries(current).slice(-20);sessionStorage.setItem(positionKey,JSON.stringify(Object.fromEntries(entries)));
  }catch{/* Private browsing/storage limits must not prevent navigation. */}
}
/** Persist navigation metadata only. Search results always use fresh API reads. */
export function useSearchNavigation({path,viewer,identityReady,resultsHref,resultsViewer}:{path:string;viewer:string;identityReady:boolean;resultsHref?:string;resultsViewer?:string}) {
  const router=useRouter(),params=useSearchParams();const state=readSearchState(params),href=searchHref(state);
  const restore=useRef({key:'',target:0,pending:true,cancelled:false});const active=path==='/discover';
  const returnHref=searchReturnHref(params.get('returnTo')),resultsReady=resultsHref===href&&resultsViewer===viewer;
  const remember=useCallback(()=>{
    if(!active||!identityReady||restore.current.pending||location.pathname!=='/discover')return;
    const liveHref=searchHref(readSearchState(new URLSearchParams(location.search)));
    if(restore.current.key===JSON.stringify([viewer,liveHref]))savePosition(liveHref,viewer,window.scrollY);
  },[active,identityReady,href,viewer]);
  useEffect(()=>{
    if(!identityReady)return;
    try {const old=sessionStorage.getItem(viewerKey);if(old&&old!==viewer)sessionStorage.removeItem(positionKey);sessionStorage.setItem(viewerKey,viewer);}catch{}
  },[identityReady,viewer]);
  useEffect(()=>{
    if(!active){restore.current={key:'',target:0,pending:true,cancelled:false};return;}
    if(!identityReady)return;
    const key=JSON.stringify([viewer,href]);
    if(restore.current.key!==key){const position=readSearchPosition(positions()[href],href,viewer);restore.current={key,target:position?.y||0,pending:true,cancelled:false};}
  },[active,identityReady,viewer,href]);
  useEffect(()=>{
    if(!active||!identityReady)return;
    let frame=0;
    const scroll=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;remember();});};
    const navigation=()=>remember();
    const pop=()=>{restore.current.pending=true;restore.current.cancelled=false;};
    const intent=(event:Event)=>{
      if(event instanceof KeyboardEvent&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;
      restore.current.pending=false;restore.current.cancelled=true;remember();
    };
    window.addEventListener('scroll',scroll,{passive:true});window.addEventListener('pagehide',navigation);
    document.addEventListener('click',navigation,true);window.addEventListener('popstate',pop);
    window.addEventListener('wheel',intent,{passive:true});window.addEventListener('touchstart',intent,{passive:true});window.addEventListener('keydown',intent);window.addEventListener('pointerdown',intent);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',scroll);window.removeEventListener('pagehide',navigation);document.removeEventListener('click',navigation,true);window.removeEventListener('popstate',pop);window.removeEventListener('wheel',intent);window.removeEventListener('touchstart',intent);window.removeEventListener('keydown',intent);window.removeEventListener('pointerdown',intent);};
  },[active,identityReady,remember]);
  useEffect(()=>{
    if(!active||!identityReady||!resultsReady||!restore.current.pending)return;
    const pending=restore.current,main=document.querySelector('main');if(!main)return;
    let live=true,frame=0,settled:ReturnType<typeof setTimeout>|undefined;
    const finish=(persist=true)=>{if(!live)return;live=false;pending.pending=!persist;observer.disconnect();cancelAnimationFrame(frame);if(settled)clearTimeout(settled);if(persist)savePosition(href,viewer,window.scrollY);};
    function apply(){
      if(!live)return;if(pending.cancelled){finish();return;}
      window.scrollTo({top:pending.target,behavior:'instant'});
      if(settled)clearTimeout(settled);
      const complete=Array.from(main!.querySelectorAll('img')).filter(image=>image.getBoundingClientRect().top+window.scrollY<=pending.target+window.innerHeight).every(image=>image.complete);
      if(complete&&Math.abs(window.scrollY-pending.target)<2)settled=setTimeout(finish,250);
    }
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(apply);});observer.observe(main);
    main.addEventListener('load',apply,true);frame=requestAnimationFrame(apply);
    const deadline=setTimeout(()=>{apply();finish(Math.abs(window.scrollY-pending.target)<2);},7000);
    return()=>{live=false;clearTimeout(deadline);if(settled)clearTimeout(settled);cancelAnimationFrame(frame);observer.disconnect();main.removeEventListener('load',apply,true);};
  },[active,identityReady,resultsReady,href,viewer]);
  const update=useCallback((patch:Partial<SearchState>)=>{
    replaceSearchQuery(window,patch,nextHref=>savePosition(nextHref,viewer,patch.pages?window.scrollY:0));
  },[viewer]);
  const openSearch=useCallback((q:string)=>{remember();router.push(searchHref({q:q.slice(0,200),type:'all',city:'',pages:1}));},[remember,router]);
  const searchResultHref=useCallback((destination:string)=>active?`${destination}${destination.includes('?')?'&':'?'}returnTo=${encodeURIComponent(href)}`:destination,[active,href]);
  return {state,href,returnHref,update,openSearch,searchResultHref,remember};
}
