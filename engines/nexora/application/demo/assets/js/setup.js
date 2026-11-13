(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORE_KEY = "nexora-studio:v1";
  const CURRENCIES = [
    {code:"USD",name:"Dólar estadounidense"},{code:"NIO",name:"Córdoba nicaragüense"},
    {code:"EUR",name:"Euro"},{code:"GBP",name:"Libra esterlina"},{code:"CAD",name:"Dólar canadiense"},
    {code:"MXN",name:"Peso mexicano"},{code:"CRC",name:"Colón costarricense"},{code:"HNL",name:"Lempira hondureño"},
    {code:"GTQ",name:"Quetzal guatemalteco"},{code:"PAB",name:"Balboa panameño"},{code:"COP",name:"Peso colombiano"},
    {code:"BRL",name:"Real brasileño"}
  ];
  const UNITS = {mass:["kg","g","lb","oz"],volume:["L","ml","gal","fl oz"],displacement:["cc"],length:["m","cm","mm","in","ft"],count:["unidad","pieza","par","paquete","caja","docena"],digital:["MB","GB","TB"],area:["m²","ft²"]};
  const TYPES = {text:"Texto",number:"Número",select:"Lista de opciones",multiselect:"Selección múltiple",boolean:"Sí / No",date:"Fecha",textarea:"Texto largo"};
  const makeId = (prefix) => prefix + "-" + Math.random().toString(36).slice(2,9);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const field = (label,type="text",extra={}) => ({id:makeId("field"),label,type,required:false,showPublic:true,searchable:false,width:"half",unitGroup:"",unit:"",options:[],...extra});
  const group = (name,fields=[]) => ({id:makeId("group"),name,fields});
  const TEMPLATES = {
    perfumery:{name:"Perfumería",description:"Fragancias, concentración, marca y presentación.",groups:[
      group("Información general",[field("Marca"),field("Fragancia"),field("Concentración","select",{options:["Eau de Parfum","Eau de Toilette","Parfum","Eau de Cologne"]})]),
      group("Presentación",[field("Contenido","number",{unitGroup:"volume",unit:"ml"}),field("Tamaño del frasco","select",{options:["Pequeño","Mediano","Grande"]})])]},
    fashion:{name:"Ropa y calzado",description:"Tallas, colores, materiales y público.",groups:[
      group("Características",[field("Talla","select",{options:["XS","S","M","L","XL","XXL"]}),field("Color","text",{searchable:true}),field("Material"),field("Público","select",{options:["Hombre","Mujer","Unisex","Niños","Niñas","Todos"]})])]},
    technology:{name:"Tecnología",description:"Marca, modelo, memoria y especificaciones.",groups:[
      group("Identificación",[field("Marca"),field("Modelo"),field("Procesador")]),
      group("Especificaciones",[field("Memoria RAM","number",{unitGroup:"digital",unit:"GB"}),field("Almacenamiento","number",{unitGroup:"digital",unit:"GB"})])]},
    gym:{name:"Gimnasio y fitness",description:"Peso, material, dimensiones y tipo de equipo.",groups:[
      group("Características",[field("Tipo de equipo"),field("Peso","number",{unitGroup:"mass",unit:"kg"}),field("Material"),field("Resistencia","select",{options:["Ligera","Media","Alta","Ajustable"]})])]},
    automotive:{name:"Repuestos y vehículos",description:"Marca, compatibilidad, año y especificaciones.",groups:[
      group("Identificación",[field("Marca"),field("Modelo compatible"),field("Año","number"),field("Código de pieza")]),
      group("Detalles técnicos",[field("Cilindraje","number",{unitGroup:"displacement",unit:"cc"}),field("Estado","select",{options:["Nuevo","Usado","Reconstruido"]})])]},
    grocery:{name:"Alimentos y abarrotes",description:"Contenido, peso, volumen y presentación.",groups:[
      group("Producto",[field("Marca"),field("Contenido","number",{unitGroup:"mass",unit:"g"}),field("Presentación","select",{options:["Individual","Paquete","Caja","A granel"]}),field("Fecha de vencimiento","date")])]},
    other:{name:"Plantilla personalizada",description:"Comienza con una estructura sencilla y agrega los campos que necesites.",groups:[group("Información adicional",[])]}
  };
  const state = {step:1,phones:[{id:makeId("phone"),number:"",isMain:true,showPublic:true}],activeCurrencies:["USD"],primaryCurrency:"USD",customUnits:clone(UNITS),groups:clone(TEMPLATES.perfumery.groups),photosEnabled:false};
  const toast = $("#studio-toast");
  let toastTimer = null;
  const notify = (message) => { if(!toast)return; toast.textContent=message; toast.classList.add("is-visible"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.remove("is-visible"),2600); };
  const val = (id) => $(id)?.value.trim() || "";
  const phoneOK = (number) => {const digits=String(number||"").replace(/\D/g,"");return digits.length>=8&&digits.length<=15;};
  const selectedType = () => $("#business-type").value;
  const unitsFor = (key) => [...(state.customUnits[key]||[])];
  const findGroup = (id) => state.groups.find((item)=>item.id===id);
  const findField = (id) => {for(const item of state.groups){const found=item.fields.find((f)=>f.id===id);if(found)return found;}return null;};

  const progress = () => {
    $$(".setup-step").forEach((panel)=>{const active=Number(panel.dataset.step)===state.step;panel.hidden=!active;panel.classList.toggle("is-active",active);});
    $$("[data-step-label]").forEach((item)=>item.classList.toggle("is-active",Number(item.dataset.stepLabel)<=state.step));
    $("#progress-fill").style.width=(state.step*25)+"%";
    $("#previous-step").disabled=state.step===1;$("#next-step").hidden=state.step===4;$("#save-setup").hidden=state.step!==4;
    if(state.step===4)review();
    window.scrollTo({top:0,behavior:"smooth"});
  };
  const validate = (step) => {
    if(step===1){
      if(val("#business-name").length<2||val("#owner-name").length<3)return "Completa el nombre del negocio y del propietario.";
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val("#owner-email")))return "Ingresa un correo electrónico válido.";
      if(!state.phones.length||state.phones.some((p)=>!phoneOK(p.number)))return "Cada número debe incluir entre 8 y 15 dígitos con su código de país.";
      if(!state.phones.some((p)=>p.isMain))return "Selecciona un número principal.";
    }
    if(step===2){
      if(!state.activeCurrencies.includes(state.primaryCurrency))return "La moneda principal debe estar habilitada.";
      for(const url of [val("#logo-url"),val("#cover-url")].filter(Boolean)){try{const parsed=new URL(url);if(!["http:","https:"].includes(parsed.protocol))throw new Error();}catch{return "Las imágenes deben utilizar URL válidas con http o https.";}}
    }
    if(step===3){
      if(!state.groups.length)return "Agrega al menos un grupo.";
      const names=new Set();
      for(const g of state.groups){
        if(!g.name.trim())return "Todos los grupos deben tener un nombre.";
        for(const f of g.fields){
          if(!f.label.trim())return "Todos los campos personalizados deben tener un nombre.";
          const key=g.id+":"+f.label.trim().toLocaleLowerCase("es");
          if(names.has(key))return "Hay campos duplicados dentro de «"+g.name+"».";
          names.add(key);
          if(["select","multiselect"].includes(f.type)&&!f.options.length)return "Agrega opciones al campo «"+f.label+"».";
          if(f.type==="number"&&f.unitGroup&& !unitsFor(f.unitGroup).includes(f.unit))return "Selecciona una unidad válida para «"+f.label+"».";
        }
      }
    }
    return "";
  };

  const renderPhones = () => {
    $("#phone-counter").textContent=state.phones.length+" / 5";$("#add-phone").disabled=state.phones.length>=5;
    $("#phone-list").replaceChildren(...state.phones.map((phone,index)=>{
      const row=document.createElement("div");row.className="phone-row";
      const input=document.createElement("input");input.type="tel";input.inputMode="tel";input.placeholder="Código de país + número";input.value=phone.number;input.maxLength=20;input.dataset.phoneNumber=phone.id;input.setAttribute("aria-label","Número de WhatsApp "+(index+1));
      const main=document.createElement("label");main.className="phone-main";const radio=document.createElement("input");radio.type="radio";radio.name="main-phone";radio.checked=phone.isMain;radio.dataset.phoneMain=phone.id;main.append(radio,document.createTextNode("Principal"));
      const pub=document.createElement("label");pub.className="phone-public";const check=document.createElement("input");check.type="checkbox";check.checked=phone.showPublic;check.dataset.phonePublic=phone.id;pub.append(check,document.createTextNode("Mostrar"));
      const remove=document.createElement("button");remove.type="button";remove.className="phone-remove";remove.textContent="×";remove.dataset.phoneRemove=phone.id;remove.setAttribute("aria-label","Eliminar número");
      row.append(input,main,pub,remove);return row;
    }));
  };
  $("#phone-list").addEventListener("input",(event)=>{const input=event.target.closest("[data-phone-number]");if(input){const p=state.phones.find((x)=>x.id===input.dataset.phoneNumber);if(p)p.number=input.value;}});
  $("#phone-list").addEventListener("change",(event)=>{
    const radio=event.target.closest("[data-phone-main]");const checkbox=event.target.closest("[data-phone-public]");
    if(radio){state.phones.forEach((p)=>p.isMain=p.id===radio.dataset.phoneMain);renderPhones();}
    if(checkbox){const p=state.phones.find((x)=>x.id===checkbox.dataset.phonePublic);if(p)p.showPublic=checkbox.checked;}
  });
  $("#phone-list").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-phone-remove]");if(!button)return;
    if(state.phones.length===1){notify("Debe quedar al menos un número registrado.");return;}
    const removed=state.phones.find((p)=>p.id===button.dataset.phoneRemove);state.phones=state.phones.filter((p)=>p.id!==button.dataset.phoneRemove);
    if(removed?.isMain)state.phones[0].isMain=true;renderPhones();
  });
  $("#add-phone").addEventListener("click",()=>{
    if(state.phones.length>=5)return;state.phones.push({id:makeId("phone"),number:"",isMain:false,showPublic:true});renderPhones();
    const inputs=$$("[data-phone-number]");inputs[inputs.length-1]?.focus();
  });

  const currencyOptions=()=>CURRENCIES.map((c)=>'<option value="'+c.code+'">'+c.code+" · "+c.name+"</option>").join("");
  $("#primary-currency").innerHTML=currencyOptions();
  $("#custom-currency").innerHTML='<option value="">Seleccionar moneda…</option>'+currencyOptions();
  $("#primary-currency").value=state.primaryCurrency;
  const renderCurrencies=()=>{
    $("#currency-list").replaceChildren(...CURRENCIES.filter((c)=>c.code!==state.primaryCurrency).map((c)=>{
      const label=document.createElement("label");label.className="choice-item";const input=document.createElement("input");input.type="checkbox";input.checked=state.activeCurrencies.includes(c.code);input.dataset.currency=c.code;label.append(input,document.createTextNode(c.code+" · "+c.name));return label;
    }));
  };
  $("#primary-currency").addEventListener("change",(event)=>{
    const old=state.primaryCurrency;state.primaryCurrency=event.target.value;state.activeCurrencies=state.activeCurrencies.filter((c)=>c!==old);
    if(!state.activeCurrencies.includes(state.primaryCurrency))state.activeCurrencies.unshift(state.primaryCurrency);renderCurrencies();
  });
  $("#currency-list").addEventListener("change",(event)=>{
    const input=event.target.closest("[data-currency]");if(!input)return;const code=input.dataset.currency;
    if(input.checked&&!state.activeCurrencies.includes(code))state.activeCurrencies.push(code);
    if(!input.checked)state.activeCurrencies=state.activeCurrencies.filter((x)=>x!==code);
  });
  $("#add-currency").addEventListener("click",()=>{
    const code=$("#custom-currency").value;if(!code){notify("Selecciona una moneda.");return;}
    if(!state.activeCurrencies.includes(code))state.activeCurrencies.push(code);renderCurrencies();$("#custom-currency").value="";
  });
  $("#brand-color").addEventListener("input",(event)=>$("#brand-color-value").value=event.target.value.toUpperCase());

  const renderPreview=()=>{
    const blocks=state.groups.map((g)=>{
      const visible=g.fields.filter((f)=>f.showPublic);if(!visible.length)return null;
      const section=document.createElement("section");section.className="preview-section";
      const title=document.createElement("h4");title.textContent=g.name;
      const fields=document.createElement("div");fields.className="preview-fields";
      visible.forEach((f)=>{
        const line=document.createElement("div");line.className="preview-field";
        if(f.width==="full")line.classList.add("is-full");
        const name=document.createElement("span");name.textContent=f.label;
        const value=document.createElement("strong");value.textContent=f.type==="number"&&f.unit?"— "+f.unit:"—";
        line.append(name,value);fields.append(line);
      });
      section.append(title,fields);return section;
    }).filter(Boolean);
    if(state.photosEnabled){const photo=document.createElement("div");photo.className="preview-photo";photo.textContent="＋ Fotografías del producto habilitadas";blocks.unshift(photo);}
    if(!blocks.length){const empty=document.createElement("div");empty.className="preview-photo";empty.textContent="Los campos básicos del producto se mantienen. No hay campos adicionales visibles.";blocks.push(empty);}
    $("#product-preview").replaceChildren(...blocks);
  };
  const renderSchema=()=>{
    $("#schema-editor").replaceChildren(...state.groups.map((g,gi)=>{
      const card=document.createElement("section");card.className="schema-group";
      const head=document.createElement("div");head.className="schema-group-head";
      const title=document.createElement("input");title.className="group-title-input";title.value=g.name;title.maxLength=60;title.dataset.groupName=g.id;title.setAttribute("aria-label","Nombre del grupo");
      const actions=document.createElement("div");actions.className="group-actions";
      [["↑","up",gi===0],["↓","down",gi===state.groups.length-1]].forEach(([text,direction,disabled])=>{const b=document.createElement("button");b.type="button";b.className="icon-action";b.textContent=text;b.dataset.groupMove=direction;b.dataset.groupId=g.id;b.disabled=disabled;actions.append(b);});
      const remove=document.createElement("button");remove.type="button";remove.className="icon-action danger";remove.textContent="×";remove.dataset.groupRemove=g.id;remove.disabled=g.fields.length>0;remove.title=g.fields.length?"Primero mueve o elimina sus campos":"Eliminar grupo vacío";actions.append(remove);head.append(title,actions);
      const fields=document.createElement("div");fields.className="schema-fields";
      g.fields.forEach((f,fi)=>{
        const row=document.createElement("div");row.className="schema-field";
        const top=document.createElement("div");top.className="schema-field-top";
        const label=document.createElement("input");label.value=f.label;label.maxLength=60;label.dataset.fieldLabel=f.id;label.setAttribute("aria-label","Nombre del campo");
        const type=document.createElement("select");type.dataset.fieldProp="type";type.dataset.fieldId=f.id;type.setAttribute("aria-label","Tipo de campo");
        type.innerHTML=Object.entries(TYPES).map(([key,text])=>'<option value="'+key+'" '+(key===f.type?"selected":"")+'>'+text+"</option>").join("");
        const tools=document.createElement("div");tools.className="schema-field-tools";
        [["↑","up",fi===0],["↓","down",fi===g.fields.length-1],["×","remove",false]].forEach(([text,direction,disabled])=>{const b=document.createElement("button");b.type="button";b.textContent=text;b.disabled=disabled;b.dataset.groupId=g.id;b.dataset.fieldId=f.id;if(direction==="remove")b.dataset.fieldRemove=f.id;else b.dataset.fieldMove=direction;tools.append(b);});
        top.append(label,type,tools);row.append(top);
        const meta=document.createElement("div");meta.className="schema-field-meta";
        [["required","Obligatorio"],["showPublic","Mostrar en catálogo"],["searchable","Permitir filtro"]].forEach(([prop,text])=>{
          const wrap=document.createElement("label");wrap.className="schema-flags";const input=document.createElement("input");input.type="checkbox";input.checked=Boolean(f[prop]);input.dataset.fieldProp=prop;input.dataset.fieldId=f.id;wrap.append(input,document.createTextNode(text));meta.append(wrap);
        });
        const width=document.createElement("select");width.dataset.fieldProp="width";width.dataset.fieldId=f.id;width.setAttribute("aria-label","Ancho del campo");width.innerHTML='<option value="half" '+(f.width==="half"?"selected":"")+'>Media columna</option><option value="full" '+(f.width==="full"?"selected":"")+'>Ancho completo</option>';meta.append(width);row.append(meta);
        if(f.type==="number"){
          const units=document.createElement("div");units.className="schema-unit";
          const groupSelect=document.createElement("select");groupSelect.dataset.fieldProp="unitGroup";groupSelect.dataset.fieldId=f.id;groupSelect.setAttribute("aria-label","Magnitud");
          groupSelect.innerHTML='<option value="">Sin unidad</option><option value="mass">Masa</option><option value="volume">Volumen</option><option value="displacement">Cilindraje de motor</option><option value="length">Longitud</option><option value="count">Cantidad</option><option value="digital">Capacidad digital</option><option value="area">Área</option>';groupSelect.value=f.unitGroup||"";units.append(groupSelect);
          if(f.unitGroup){const unit=document.createElement("select");unit.dataset.fieldProp="unit";unit.dataset.fieldId=f.id;unit.setAttribute("aria-label","Unidad");unit.innerHTML='<option value="">Seleccionar unidad…</option>'+unitsFor(f.unitGroup).map((u)=>'<option value="'+esc(u)+'" '+(u===f.unit?"selected":"")+'>'+esc(u)+"</option>").join("");units.append(unit);}
          row.append(units);
        }
        if(["select","multiselect"].includes(f.type)){const options=document.createElement("textarea");options.rows=2;options.value=(f.options||[]).join("\n");options.placeholder="Una opción por línea";options.dataset.fieldOptions=f.id;options.setAttribute("aria-label","Opciones del campo");row.append(options);}
        fields.append(row);
      });
      const hint=document.createElement("p");hint.className="helper-note";hint.textContent=g.fields.length?g.fields.length+" campo(s) en este grupo.":"Grupo vacío: agrega un campo o elimínalo.";
      card.append(head,fields,hint);return card;
    }));
    renderPreview();
  };
  $("#schema-editor").addEventListener("input",(event)=>{
    const gn=event.target.closest("[data-group-name]");const fl=event.target.closest("[data-field-label]");const fo=event.target.closest("[data-field-options]");
    if(gn){const g=findGroup(gn.dataset.groupName);if(g)g.name=gn.value;renderPreview();}
    if(fl){const f=findField(fl.dataset.fieldLabel);if(f)f.label=fl.value;renderPreview();}
    if(fo){const f=findField(fo.dataset.fieldOptions);if(f)f.options=fo.value.split("\n").map((x)=>x.trim()).filter(Boolean).slice(0,30);}
  });
  $("#schema-editor").addEventListener("change",(event)=>{
    const control=event.target.closest("[data-field-prop]");if(!control)return;const f=findField(control.dataset.fieldId);if(!f)return;
    const prop=control.dataset.fieldProp;f[prop]=control.type==="checkbox"?control.checked:control.value;
    if(prop==="type"&&!["select","multiselect"].includes(f.type))f.options=[];
    if(prop==="unitGroup")f.unit=f.unitGroup?unitsFor(f.unitGroup)[0]:"";
    renderSchema();
  });
  $("#schema-editor").addEventListener("click",(event)=>{
    const fr=event.target.closest("[data-field-remove]");const fm=event.target.closest("[data-field-move]");const gm=event.target.closest("[data-group-move]");const gr=event.target.closest("[data-group-remove]");
    if(fr){const g=findGroup(fr.dataset.groupId);if(g)g.fields=g.fields.filter((f)=>f.id!==fr.dataset.fieldRemove);renderSchema();return;}
    if(fm){const g=findGroup(fm.dataset.groupId);if(!g)return;const i=g.fields.findIndex((f)=>f.id===fm.dataset.fieldId);const n=fm.dataset.fieldMove==="up"?i-1:i+1;if(i<0||n<0||n>=g.fields.length)return;[g.fields[i],g.fields[n]]=[g.fields[n],g.fields[i]];renderSchema();return;}
    if(gm){const i=state.groups.findIndex((g)=>g.id===gm.dataset.groupId);const n=gm.dataset.groupMove==="up"?i-1:i+1;if(i<0||n<0||n>=state.groups.length)return;[state.groups[i],state.groups[n]]=[state.groups[n],state.groups[i]];renderSchema();return;}
    if(gr){const g=findGroup(gr.dataset.groupRemove);if(g?.fields.length){notify("El grupo debe estar vacío para eliminarlo.");return;}state.groups=state.groups.filter((g)=>g.id!==gr.dataset.groupRemove);renderSchema();}
  });
  $("#add-field").addEventListener("click",()=>{if(!state.groups.length)state.groups.push(group("Información adicional"));state.groups[state.groups.length-1].fields.push(field("Nuevo campo"));renderSchema();notify("Campo agregado.");});
  $("#add-group").addEventListener("click",()=>{state.groups.push(group("Nuevo grupo"));renderSchema();notify("Grupo agregado.");});
  $("#photos-enabled").addEventListener("change",(event)=>{state.photosEnabled=event.target.checked;renderPreview();});
  $("#business-type").addEventListener("change",(event)=>{
    const type=event.target.value;const next=TEMPLATES[type]||TEMPLATES.other;
    const customized=state.groups.some((g)=>g.fields.length);
    if(customized&&!window.confirm("Cambiar de plantilla reemplazará los campos actuales. ¿Deseas continuar?")){
      event.target.value=Object.keys(TEMPLATES).find((key)=>TEMPLATES[key].name===$("#template-name").textContent)||"other";return;
    }
    state.groups=clone(next.groups);$("#template-name").textContent=next.name;$("#template-description").textContent=next.description;renderSchema();
  });
  $("#add-unit").addEventListener("click",()=>{
    const key=$("#custom-unit-group").value;const name=val("#custom-unit-name");if(!name){notify("Escribe el nombre o abreviatura de la unidad.");return;}
    if(!state.customUnits[key].some((u)=>u.toLocaleLowerCase("es")===name.toLocaleLowerCase("es"))){state.customUnits[key].push(name);$("#unit-feedback").textContent="Unidad «"+name+"» agregada a la biblioteca.";$("#custom-unit-name").value="";renderSchema();}
    else notify("Esa unidad ya existe.");
  });

  const review=()=>{
    const template=TEMPLATES[selectedType()]||TEMPLATES.other;
    $("#review-business-name").textContent=val("#business-name");$("#review-business-type").textContent=template.name;
    $("#review-owner").textContent=val("#owner-name");$("#review-email").textContent=val("#owner-email");
    $("#review-currency").textContent=state.primaryCurrency+(state.activeCurrencies.length>1?" +"+(state.activeCurrencies.length-1):"");
    $("#review-phones").textContent=state.phones.filter((p)=>p.showPublic).length+" visibles / "+state.phones.length+" registrados";
    $("#review-photos").textContent=state.photosEnabled?"Habilitadas":"Deshabilitadas";
    $("#review-fields").textContent=state.groups.reduce((sum,g)=>sum+g.fields.length,0)+" personalizados";
    $("#review-template").textContent=template.name;
    $("#review-groups").replaceChildren(...state.groups.map((g)=>{const line=document.createElement("div");line.className="review-group-line";const strong=document.createElement("strong");strong.textContent=g.name+": ";line.append(strong,document.createTextNode(g.fields.map((f)=>f.label).join(", ")||"Sin campos"));return line;}));
  };
  const payload=()=>({
    schemaVersion:1,mode:"demo-local-only",savedAt:new Date().toISOString(),
    business:{name:val("#business-name"),type:selectedType(),owner:{name:val("#owner-name"),email:val("#owner-email")},phones:state.phones.map((p)=>({number:p.number.replace(/\D/g,""),isMain:p.isMain,showPublic:p.showPublic}))},
    identity:{logoUrl:val("#logo-url"),coverUrl:val("#cover-url"),description:val("#business-description"),primaryColor:$("#brand-color").value,location:val("#business-location"),hours:val("#business-hours")},
    pricing:{primaryCurrency:state.primaryCurrency,enabledCurrencies:[...new Set(state.activeCurrencies)]},
    catalog:{template:selectedType(),photosEnabled:state.photosEnabled,systemFields:["name","description","category","price","status"],groups:clone(state.groups),units:clone(state.customUnits)},
    productionRequirements:{emailVerification:true,passwordHashing:"framework-managed",serverAuthorization:true,separateDatabasePerInstallation:true,photosStoredOnServer:true}
  });
  $("#save-setup").addEventListener("click",()=>{
    const error=validate(3);if(error){$("#save-feedback").textContent=error;return;}
    try{localStorage.setItem(STORE_KEY,JSON.stringify(payload()));$("#save-feedback").textContent="Configuración de demostración guardada en este navegador.";notify("Configuración guardada localmente.");}
    catch{$("#save-feedback").textContent="No fue posible guardar. El almacenamiento del navegador puede estar lleno o bloqueado.";}
  });
  $("#previous-step").addEventListener("click",()=>{if(state.step>1){state.step--;progress();}});
  $("#next-step").addEventListener("click",()=>{
    const error=validate(state.step);if(error){notify(error);return;}
    if(state.step<4){state.step++;progress();}
  });

  const loadSaved=()=>{
    try{
      const saved=JSON.parse(localStorage.getItem(STORE_KEY)||"null");
      if(saved?.schemaVersion!==1||!saved.business||!saved.catalog)return;
      $("#business-name").value=saved.business.name||"";$("#owner-name").value=saved.business.owner?.name||"";$("#owner-email").value=saved.business.owner?.email||"";
      $("#business-type").value=TEMPLATES[saved.business.type]?saved.business.type:"other";
      state.phones=(saved.business.phones||[]).slice(0,5).map((p)=>({id:makeId("phone"),...p}));
      if(!state.phones.length)state.phones=[{id:makeId("phone"),number:"",isMain:true,showPublic:true}];
      if(!state.phones.some((p)=>p.isMain))state.phones[0].isMain=true;
      renderPhones();
      $("#logo-url").value=saved.identity?.logoUrl||"";$("#cover-url").value=saved.identity?.coverUrl||"";$("#business-description").value=saved.identity?.description||"";
      $("#brand-color").value=saved.identity?.primaryColor||"#a6c940";$("#brand-color-value").value=$("#brand-color").value.toUpperCase();
      $("#business-location").value=saved.identity?.location||"";$("#business-hours").value=saved.identity?.hours||"";
      state.primaryCurrency=CURRENCIES.some((c)=>c.code===saved.pricing?.primaryCurrency)?saved.pricing.primaryCurrency:"USD";
      state.activeCurrencies=saved.pricing?.enabledCurrencies||[state.primaryCurrency];$("#primary-currency").value=state.primaryCurrency;renderCurrencies();
      state.customUnits=saved.catalog?.units||clone(UNITS);state.groups=saved.catalog?.groups||clone(TEMPLATES[saved.business.type]?.groups||TEMPLATES.other.groups);
      state.photosEnabled=Boolean(saved.catalog?.photosEnabled);$("#photos-enabled").checked=state.photosEnabled;
      $("#template-name").textContent=TEMPLATES[$("#business-type").value].name;$("#template-description").textContent=TEMPLATES[$("#business-type").value].description;renderSchema();
    }catch{localStorage.removeItem(STORE_KEY);}
  };
  renderPhones();renderCurrencies();$("#template-name").textContent=TEMPLATES.perfumery.name;$("#template-description").textContent=TEMPLATES.perfumery.description;renderSchema();loadSaved();progress();
})();