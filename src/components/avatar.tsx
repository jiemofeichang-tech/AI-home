'use client';

import { useState } from 'react';

export function Avatar({name='新朋友',image,size='normal'}:{name?:string;image?:string|null;size?:string}) {
  const [failedImage,setFailedImage]=useState<string|null>(null);
  const hue=Array.from(name).reduce((n,c)=>n+c.charCodeAt(0),0)%360;
  return <span className={`avatar ${size}`} role="img" aria-label={`${name}的头像`} style={{background:`hsl(${hue} 22% 94%)`,color:`hsl(${hue} 18% 34%)`}}>
    {image&&image!==failedImage?<img src={image} alt="" decoding="async" onError={()=>setFailedImage(image)}/>:name.slice(0,1)}
  </span>;
}
