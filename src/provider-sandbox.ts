import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function confinedProviderCommand(bin:string,args:string[],writableRoots:string[]):Promise<{bin:string;args:string[]}>{
  if(process.platform!=='darwin')throw new Error('custom Provider requires a supported OS process sandbox');
  const roots=[...new Set(await Promise.all(writableRoots.map(root=>realpath(root))))];
  if(roots.some(root=>root===path.parse(root).root))throw new Error('Provider sandbox may not write the filesystem root');
  const profile=['(version 1)','(deny default)','(allow process*)','(allow file-read*)','(allow mach*)','(allow sysctl*)','(allow ipc*)','(allow file-write* (literal "/dev/null"))',
    ...roots.map(root=>`(allow file-write* (subpath ${JSON.stringify(root)}))`)].join('\n');
  return{bin:'/usr/bin/sandbox-exec',args:['-p',profile,bin,...args]};
}
