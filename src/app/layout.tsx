import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'AI 社区 · 和同路人一起创造',description:'分享 AI 实践与开源项目，连接同城伙伴，让你的 Agent 参与社区。',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="zh-CN"><body>{children}</body></html>;}
