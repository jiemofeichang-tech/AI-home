import { Meilisearch } from 'meilisearch';
import { config } from './config';
export const searchClient=config.meili?new Meilisearch({host:config.meili,apiKey:process.env.MEILI_MASTER_KEY,timeout:2500}):null;
export async function searchCandidates(q:string):Promise<string[]> {
  if(!searchClient)return [];
  try{const result=await searchClient.index('posts').search(q,{limit:200,attributesToRetrieve:['id']});return result.hits.map(h=>String(h.id));}
  catch(error){console.error('Search index unavailable; using database search:',(error as Error).message);return [];}
}
