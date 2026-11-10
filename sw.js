// ════════════════════════════════════════════════════════════════════
// «DISFRUTA LA VIDA» · FUNCIONAR SIN CONEXIÓN · v169
// ════════════════════════════════════════════════════════════════════
// Guarda una copia de la app (las dos páginas, motor.js y el icono) y del
// lector de PDF. Con conexión manda SIEMPRE lo del servidor: cada vez que abres
// la app se pide la versión de GitHub y se guarda la copia nueva, así que una
// versión recién subida se ve al momento. La copia solo se usa si no hay red:
// sin cobertura, la app abre con lo último que se cargó.
// Tus datos no pasan por aquí: están en el almacén del navegador (IndexedDB).
const CACHE='dlv-v169';
const PROPIOS=['','index.html','nueva.html','motor.js','icon.png'];
const PDFJS=/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\//;

function base(){ return new URL(self.registration.scope).pathname; }   // p. ej. /patrimonio/
function relativa(url){
  if(url.origin!==self.location.origin)return null;
  const b=base();
  if(!url.pathname.startsWith(b))return null;
  const r=url.pathname.slice(b.length);
  return PROPIOS.includes(r)?r:null;
}
function clave(url){ return url.origin+url.pathname; }   // sin el ?v= del motor

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE)
    .then(c=>Promise.all(PROPIOS.map(r=>fetch(base()+r,{cache:'no-cache'})
      .then(res=>{ if(res&&res.ok)return c.put(self.location.origin+base()+r,res); })
      .catch(()=>{}))))
    .then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(ks=>Promise.all(ks.filter(k=>k.startsWith('dlv-')&&k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(relativa(url)!=null){
    // primero la red; si no hay, la copia
    e.respondWith(fetch(url.href,{cache:'no-cache',credentials:'same-origin'})
      .then(res=>{
        if(res&&res.ok){ const cp=res.clone(); e.waitUntil(caches.open(CACHE).then(c=>c.put(clave(url),cp))); }
        return res;
      })
      .catch(()=>caches.match(clave(url)).then(r=>r||caches.match(req,{ignoreSearch:true}))
        .then(r=>r||new Response('Sin conexión y sin copia guardada de este archivo.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}}))));
    return;
  }
  if(PDFJS.test(req.url)){
    // el lector de PDF es de una versión fija y no cambia: primero la copia
    e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{
      if(res&&res.ok){ const cp=res.clone(); e.waitUntil(caches.open(CACHE).then(c=>c.put(req,cp))); }
      return res;
    })));
  }
});
