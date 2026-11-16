import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { sha } from './store.ts';
const send=(res:ServerResponse,status:number,body:unknown)=>{const s=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(s),'x-github-request-id':sha(s).slice(0,16)});res.end(s);};
export function createApp(){return createServer(async(req:IncomingMessage,res:ServerResponse)=>{const p=new URL(req.url||'/', 'http://local').pathname;if(req.method==='GET'&&p==='/healthz'){send(res,200,{ok:true});return;}if(await handleRest(req,res)||await handleGraphql(req,res)||await handleMcp(req,res)||await handleGit(req,res))return;send(res,404,{message:'Not Found'});});}
