import { spawn } from 'node:child_process';
import { startManagedExecutionView } from './execution-view-server.js';

type Services={
  interactive?:boolean;ci?:boolean;
  startView?:(root:string,timeoutMs:number)=>Promise<{url:string}|null>;
  openBrowser?:(url:string,warn:(message:string)=>void)=>void|Promise<void>;
  log?:(message:string)=>void;warn?:(message:string)=>void;
};

function openSystemBrowser(url:string,warn:(message:string)=>void):void{
  const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'cmd':'xdg-open';
  const args=process.platform==='win32'?['/c','start','',url]:[url];
  const child=spawn(command,args,{detached:true,stdio:'ignore'});
  child.on('error',error=>warn(`spec-loop view browser unavailable: ${error.message}`));
  child.unref();
}

export async function maybeAutoOpenExecutionView(projectRoot:string|null,options:{view?:boolean;json?:boolean}={},services:Services={}):Promise<void>{
  const interactive=services.interactive??Boolean(process.stdin.isTTY&&process.stdout.isTTY);
  const ci=services.ci??Boolean(process.env.CI);
  if(!projectRoot||options.view===false||ci||!interactive)return;
  const log=services.log??(options.json?console.error:console.log),warn=services.warn??console.error;
  try{
    const marker=await (services.startView??((root,timeoutMs)=>startManagedExecutionView(root,0,{timeoutMs})))(projectRoot,4500);
    if(!marker)throw new Error('execution view did not return a verified owner marker');
    log(`spec-loop execution view: ${marker.url}`);
    try{await (services.openBrowser??openSystemBrowser)(marker.url,warn);}
    catch(error){warn(`spec-loop view browser unavailable: ${(error as Error).message}`);}
  }catch(error){warn(`spec-loop view unavailable: ${(error as Error).message}`);}
}
