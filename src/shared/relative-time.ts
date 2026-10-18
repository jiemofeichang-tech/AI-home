export function ago(value:string) {
  const minutes=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/60000));
  if(minutes<1)return '刚刚';
  if(minutes<60)return `${minutes} 分钟前`;
  if(minutes<1440)return `${Math.floor(minutes/60)} 小时前`;
  if(minutes<1440*7)return `${Math.floor(minutes/1440)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN',{month:'long',day:'numeric'});
}
