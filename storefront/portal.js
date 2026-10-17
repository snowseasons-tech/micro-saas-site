(function(){
 var form=document.getElementById('login'),account=document.getElementById('account'),logout=document.getElementById('logout');
 var who=document.getElementById('email-display'),msg=document.getElementById('login-msg'),catalog=document.getElementById('catalog');
 var search=document.getElementById('search'),category=document.getElementById('category'),apps=[];
 var CATEGORIES={billing:'Billing & Finance',utilities:'Developer Utilities'};

 function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
 function note(text){catalog.replaceChildren(el('p','muted',text))}

 function render(){
  var q=search.value.trim().toLowerCase(),c=category.value;
  var shown=apps.filter(function(a){return(!c||a.category===c)&&(!q||a.name.toLowerCase().indexOf(q)>=0)});
  if(!apps.length)return note('No applications are assigned to your account yet. Contact your administrator.');
  if(!shown.length)return note('No applications match your search.');
  catalog.replaceChildren.apply(catalog,shown.map(function(a){
   var card=el('article','app-card');
   card.appendChild(el('span','meta',CATEGORIES[a.category]||'Application'));
   card.appendChild(el('h3',null,a.name));
   if(a.sha256){var sum=el('p','muted');sum.appendChild(document.createTextNode('SHA-256 '));sum.appendChild(el('code',null,a.sha256));card.appendChild(sum)}
   var d=el('div','details');
   d.appendChild(el('span','muted',a.version?'Version '+a.version:'Latest release'));
   if(a.download){var link=el('a',null,'Download');link.href='/api/app-download?product='+encodeURIComponent(a.id);d.appendChild(link)}
   card.appendChild(d);
   return card
  }))
 }

 function signedIn(d){
  apps=d.apps||[];who.textContent=d.email;
  form.hidden=true;account.hidden=false;logout.hidden=false;search.disabled=false;category.disabled=false;
  render()
 }
 function signedOut(){
  apps=[];form.hidden=false;account.hidden=true;logout.hidden=true;search.disabled=true;category.disabled=true;
  search.value='';category.value='';note('Sign in to view the application catalog.')
 }

 function loadMe(){
  return fetch('/api/me',{credentials:'same-origin'}).then(function(r){
   if(r.status===401)return signedOut();
   return r.json().then(function(d){if(!r.ok)throw new Error(d.error);signedIn(d)})
  }).catch(function(){note('Could not load your workspace. Refresh to retry.')})
 }

 form.addEventListener('submit',function(e){
  e.preventDefault();
  var btn=form.querySelector('button[type=submit]');btn.disabled=true;msg.hidden=true;
  fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:form.email.value,password:form.password.value})})
  .then(function(r){return r.json().then(function(d){
   if(!r.ok)throw new Error(d.error||'Sign-in failed');
   form.reset();return loadMe()
  })})
  .catch(function(err){msg.textContent=err.message||'Sign-in failed';msg.hidden=false})
  .then(function(){btn.disabled=false})
 });

 logout.addEventListener('click',function(){
  fetch('/api/logout',{method:'POST',credentials:'same-origin'}).catch(function(){}).then(signedOut)
 });
 // Product cards: names and prices come from Stripe via /api/products, never from this file.
 function money(p){return new Intl.NumberFormat('en-US',{style:'currency',currency:p.currency.toUpperCase()}).format(p.amount/100)}
 function loadProducts(){
  var grid=document.getElementById('product-grid');
  fetch('/api/products').then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error);return d})}).then(function(d){
   if(!d.products||!d.products.length)return grid.replaceChildren(el('p','muted','No products are available right now.'));
   grid.replaceChildren.apply(grid,d.products.map(function(p){
    var card=el('article','product-card');
    card.appendChild(el('span','product-tier',p.interval?'SUBSCRIPTION':'ONE-TIME'));
    card.appendChild(el('h3',null,p.name));
    if(p.blurb)card.appendChild(el('p',null,p.blurb));
    var f=el('div','product-footer'),link=el('a',null,'View checkout');
    f.appendChild(el('strong',null,money(p)+(p.interval?' / '+p.interval:'')));
    link.href='checkout.html';f.appendChild(link);card.appendChild(f);
    return card
   }))
  }).catch(function(){grid.replaceChildren(el('p','muted','Could not load products. Please refresh.'))})
 }

 search.addEventListener('input',render);
 category.addEventListener('change',render);
 loadMe();
 loadProducts()
})();
