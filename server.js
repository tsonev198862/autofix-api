// AutoFix API Backend — Express Server for Railway
// All suppliers in one place: Impex, APEC, Emex, Stimo, Thunder, Rotinger

const express = require('express');
const cors = require('cors');
const https = require('https');
const nodeFetch = require('node-fetch');

// Create HTTPS agent that ignores SSL errors (for PitMax)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Custom fetch for Thunder (PitMax has bad SSL cert)
const fetchThunder = (url, options = {}) => {
  return nodeFetch(url, { ...options, agent: httpsAgent });
};

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ============ CACHES (persist in memory - no cold starts!) ============
let cachedRates = null;
let ratesExpiry = null;
let apecToken = null;
let apecTokenExpiry = null;
let apecDeliveryPoints = null;
let emexCid = null;
let emexLoginTime = null;
let stimoCookies = null;
let stimoLoginTime = null;
let thunderCookies = null;
let thunderSessionExpiry = null;

// ============ EXCHANGE RATES ============
async function getExchangeRates() {
  if (cachedRates && ratesExpiry && Date.now() < ratesExpiry) {
    return cachedRates;
  }
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=EUR&to=JPY,USD');
    const data = await response.json();
    if (data.rates) {
      cachedRates = {
        jpyToEur: 1 / data.rates.JPY,
        usdToEur: 1 / data.rates.USD
      };
      ratesExpiry = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
      console.log('Exchange rates updated:', cachedRates);
      return cachedRates;
    }
  } catch (err) {
    console.warn('Exchange rate fetch failed:', err.message);
  }
  return cachedRates || { jpyToEur: 0.0061, usdToEur: 0.92 };
}

// ============ IMPEX JAPAN ============
async function searchImpex(partNumber) {
  const params = new URLSearchParams({
    key: '-EoJIknVUaTUeo8Jk6bV',
    part_no: partNumber,
    original_only: '0',
    price_factor: '1',
    price_increase: '0'
  });
  
  const response = await fetch(`https://www.impex-jp.com/api/parts/search.html?${params}`, {
    headers: { 'Accept': 'application/json' }
  });
  
  if (!response.ok) return [];
  const data = await response.json();
  return data.original_parts || [];
}

// ============ APEC DUBAI ============
async function getApecToken() {
  if (apecToken && apecTokenExpiry && Date.now() < apecTokenExpiry - 300000) {
    return apecToken;
  }
  
  const username = process.env.APEC_USERNAME;
  const password = process.env.APEC_PASSWORD;
  if (!username || !password) throw new Error('APEC credentials not configured');
  
  const response = await fetch('https://api.apecauto.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&grant_type=password`
  });
  
  if (!response.ok) throw new Error(`APEC auth failed: ${response.status}`);
  
  const data = await response.json();
  apecToken = data.access_token;
  apecTokenExpiry = Date.now() + (data.expires_in * 1000);
  return apecToken;
}

async function getApecDeliveryPoints(token) {
  if (apecDeliveryPoints) return apecDeliveryPoints;
  
  const response = await fetch('https://api.apecauto.com/api/getdeliverypoints', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) return [];
  apecDeliveryPoints = await response.json();
  return apecDeliveryPoints;
}

async function searchApec(partNumber, token, deliveryPointID) {
  const cleanPN = partNumber.replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase();
  
  const brandsUrl = `https://api.apecauto.com/api/search/${encodeURIComponent(cleanPN)}/brands?analogues=false&deliveryPointID=${deliveryPointID}`;
  const brandsResp = await fetch(brandsUrl, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!brandsResp.ok) return [];
  const brands = await brandsResp.json();
  if (!brands || brands.length === 0) return [];
  
  const batchBody = brands.slice(0, 3).map(b => ({ PartNumber: cleanPN, Brand: b.Brand }));
  const searchResp = await fetch(`https://api.apecauto.com/api/search?deliveryPointID=${deliveryPointID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(batchBody)
  });
  
  if (!searchResp.ok) return [];
  const data = await searchResp.json();
  return (Array.isArray(data) ? data : []).filter(item => item.Price != null && item.Price > 0);
}

// ============ EMEX DUBAI ============
const EMEX_SOAP_URL = 'https://soap.emexdwc.ae/service.asmx';
const EMEX_NS = 'https://soap.emexdwc.ae/';
const EMEX_USER = process.env.EMEX_USER || 'QCJD';
const EMEX_PASS = process.env.EMEX_PASS || 'Banskolesi123!';

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

async function soapCall(action, body) {
  const resp = await fetch(EMEX_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"${EMEX_NS}${action}"` },
    body: soapEnvelope(body)
  });
  return await resp.text();
}

function xv(xml, tag) { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')); return m ? m[1] : null; }
function xAll(xml, tag) { const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'); const out = []; let m; while ((m = re.exec(xml)) !== null) out.push(m[1]); return out; }

async function emexLogin() {
  if (emexCid && emexLoginTime && (Date.now() - emexLoginTime < 30 * 60 * 1000)) return emexCid;
  const xml = await soapCall('Login', `<Login xmlns="${EMEX_NS}"><Customer><UserName>${escXml(EMEX_USER)}</UserName><Password>${escXml(EMEX_PASS)}</Password></Customer></Login>`);
  const cid = xv(xml, 'CustomerId');
  if (!cid || cid === '0') throw new Error(xv(xml, 'faultstring') || 'Emex login failed');
  emexCid = cid;
  emexLoginTime = Date.now();
  return cid;
}

async function searchEmex(partNumber) {
  try {
    const cid = await emexLogin();
    const xml = await soapCall('SearchPartEx', `<SearchPartEx xmlns="${EMEX_NS}"><Customer><UserName>${escXml(EMEX_USER)}</UserName><Password>${escXml(EMEX_PASS)}</Password><CustomerId>${cid}</CustomerId></Customer><DetailNum>${escXml(partNumber)}</DetailNum><ShowSubsts>false</ShowSubsts></SearchPartEx>`);
    const items = xAll(xml, 'FindByNumber');
    return items.map(item => ({
      make: xv(item, 'Make') || '',
      makeName: xv(item, 'MakeName') || '',
      number: xv(item, 'DetailNum') || '',
      name: xv(item, 'PartNameEng') || xv(item, 'PartNameRus') || '',
      price: parseFloat(xv(item, 'Price') || '0'),
      days: parseInt(xv(item, 'Delivery') || '0'),
      qty: parseInt(xv(item, 'Available') || '0'),
      weight: parseFloat(xv(item, 'WeightGr') || '0') / 1000,
      percentSupplied: parseInt(xv(item, 'PercentSupped') || '0'),
    })).filter(item => item.price > 0);
  } catch (err) {
    console.warn('Emex search error:', err.message);
    return [];
  }
}

// ============ STIMO (OEM Japan Parts) ============
const STIMO_BASE = 'https://dealers.oemjapanparts.com';
const STIMO_EMAIL = process.env.STIMO_EMAIL || 'autofixparts24@gmail.com';
const STIMO_PASS = process.env.STIMO_PASS || '11112222';

function extractCookies(headers) {
  const raw = headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(/,(?=[^ ])/).map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
}

function mergeCookies(a, b) {
  if (!b) return a || '';
  if (!a) return b;
  const m = {};
  a.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) m[k.trim()] = v.join('='); });
  b.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) m[k.trim()] = v.join('='); });
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function stimoLogin() {
  if (stimoCookies && stimoLoginTime && (Date.now() - stimoLoginTime < 25 * 60 * 1000)) {
    return stimoCookies;
  }
  
  let cookies = '';
  try {
    const homeResp = await fetch(`${STIMO_BASE}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'manual'
    });
    cookies = extractCookies(homeResp.headers);
  } catch (e) { /* ok */ }
  
  const loginBody = new URLSearchParams({ info: '', email: STIMO_EMAIL, pass: STIMO_PASS });
  const loginResp = await fetch(`${STIMO_BASE}/login.html`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${STIMO_BASE}/`,
      'Cookie': cookies
    },
    body: loginBody.toString(),
    redirect: 'manual'
  });
  
  cookies = mergeCookies(cookies, extractCookies(loginResp.headers));
  const location = loginResp.headers.get('location');
  
  if (location) {
    const redirectUrl = location.startsWith('http') ? location : `${STIMO_BASE}/${location.replace(/^\//, '')}`;
    const redirectResp = await fetch(redirectUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies },
      redirect: 'manual'
    });
    cookies = mergeCookies(cookies, extractCookies(redirectResp.headers));
  }
  
  stimoCookies = cookies;
  stimoLoginTime = Date.now();
  console.log('Stimo: logged in');
  return cookies;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#?\w+;/g, '').replace(/\s+/g, ' ').trim();
}

function parsePrice(str) {
  if (!str) return 0;
  const cleaned = str.replace(/[€\s]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

async function searchStimo(partNumber) {
  try {
    const cookies = await stimoLogin();
    const pn = partNumber.replace(/[\s-]/g, '');
    const searchUrl = `${STIMO_BASE}/advsearch.html?search_type=full&partnums=${encodeURIComponent(pn.toLowerCase())}&submit=1`;
    
    const searchResp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies
      }
    });
    
    if (!searchResp.ok) return [];
    const html = await searchResp.text();
    
    if (html.includes('ВХОД ЗА КЛИЕНТИ') && !html.includes('ИЗТОЧНИК')) {
      stimoCookies = null; // Force re-login
      return [];
    }
    
    // Parse results table
    const results = [];
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const [, source, oeNumber, description, brand, priceWithVat, yourPrice, availability, deliveryTime] = match;
      const cleanOe = stripTags(oeNumber).trim();
      const cleanBrand = stripTags(brand).trim();
      if (cleanOe.toLowerCase() === 'ое номер' || !cleanOe) continue;
      
      const rawAvail = availability || '';
      const hasStock = !rawAvail.includes('Nopresent') && !stripTags(availability).includes('---');
      
      results.push({
        source: stripTags(source).trim(),
        partNumber: cleanOe,
        description: stripTags(description).trim(),
        brand: cleanBrand,
        priceWithVat: parsePrice(stripTags(priceWithVat)),
        yourPrice: parsePrice(stripTags(yourPrice)),
        inStock: hasStock,
        deliveryDays: stripTags(deliveryTime).trim() || '-'
      });
    }
    
    return results;
  } catch (err) {
    console.warn('Stimo search error:', err.message);
    return [];
  }
}

// ============ THUNDER (PitMax) — Direct with SSL bypass ============
const THUNDER_BASE = 'https://pitmaxauto.com';
const THUNDER_GWT_USER = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/GWTWebServiceUser`;
const THUNDER_GWT_PITMAX = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/GWTWebServicePITMax`;
const THUNDER_MODULE = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/`;
const THUNDER_PERM = '70709A8D465EC375F1DBE979394D3AB3';
const THUNDER_POL_LOGIN = 'CBA32746B023408F8C29D3768C24D68B';
const THUNDER_POL_SEARCH = '48FDBB0C1ABD9AB543E5F4D21ABEB03D';
const THUNDER_USER = process.env.THUNDER_USER || 'autofix.parts';
const THUNDER_PASS = process.env.THUNDER_PASS || '414001';

const THUNDER_HEADERS = {
  'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
  'X-GWT-Module-Base': THUNDER_MODULE,
  'X-GWT-Permutation': THUNDER_PERM,
  'Origin': THUNDER_BASE,
  'Referer': `${THUNDER_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function parseGwtResponse(text) {
  if (text.startsWith('//EX')) throw new Error('GWT Exception');
  if (!text.startsWith('//OK')) throw new Error('Bad GWT response');
  const content = text.substring(4);
  const lastBracket = content.lastIndexOf('["');
  if (lastBracket === -1) return { stringTable: [] };
  let depth = 0, end = -1;
  for (let i = lastBracket; i < content.length; i++) {
    if (content[i] === '[') depth++;
    else if (content[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) end = content.length;
  try {
    return { stringTable: JSON.parse(content.substring(lastBracket, end)) };
  } catch (e) {
    const strings = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(content)) !== null) strings.push(m[1]);
    return { stringTable: strings };
  }
}

async function thunderLogin() {
  if (thunderCookies && thunderSessionExpiry && Date.now() < thunderSessionExpiry) {
    return thunderCookies;
  }
  
  console.log('Thunder: logging in...');
  let cookies = '';
  try {
    const r = await fetchThunder(THUNDER_BASE, { headers: { 'User-Agent': THUNDER_HEADERS['User-Agent'] } });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) cookies = setCookie.split(';')[0];
  } catch (e) { 
    console.log('Thunder homepage error:', e.message);
  }
  
  const payload = `7|0|7|${THUNDER_MODULE}|${THUNDER_POL_LOGIN}|com.iisd.uiw.um.client.user.s.UserGWTWS|login|java.lang.String/2004016611|${THUNDER_USER}|${THUNDER_PASS}|1|2|3|4|2|5|5|6|7|`;
  const resp = await fetchThunder(THUNDER_GWT_USER, {
    method: 'POST',
    headers: { ...THUNDER_HEADERS, 'Cookie': cookies },
    body: payload
  });
  
  const newCookies = resp.headers.get('set-cookie');
  if (newCookies) cookies = mergeCookies(cookies, newCookies.split(';')[0]);
  
  const body = await resp.text();
  console.log('Thunder login response:', body.substring(0, 50));
  if (!body.startsWith('//OK')) throw new Error('Thunder login failed');
  
  thunderCookies = cookies;
  thunderSessionExpiry = Date.now() + 30 * 60 * 1000;
  console.log('Thunder: logged in OK');
  return cookies;
}

async function searchThunder(partNumber) {
  try {
    const cookies = await thunderLogin();
    const pn = partNumber.toLowerCase();
    
    // getManyParts
    const p1 = `7|0|12|${THUNDER_MODULE}|${THUNDER_POL_SEARCH}|com.iisd.uiw.auto.client.search.oe.s.PartSearchGWTWS|getManyParts|com.iisd.fw.data.IISDResultSetDef/4116809468|[Lcom.iisd.fw.data.IISDResultSetFilterDef;/1103246466|com.iisd.fw.data.IISDResultSetFilterDef/3152666539|MarkGroupStationID|0|MarkGroupID|ProdNum|${pn}|1|2|3|4|1|5|5|2|0|0|6|3|7|0|8|0|0|0|9|7|0|10|0|0|0|9|7|0|11|0|0|2|12|0|0|30|`;
    const r1 = await fetchThunder(THUNDER_GWT_PITMAX, {
      method: 'POST',
      headers: { ...THUNDER_HEADERS, 'Cookie': cookies },
      body: p1
    });
    const b1 = await r1.text();
    console.log('Thunder getManyParts:', b1.substring(0, 50));
    if (!b1.startsWith('//OK')) return [];
    
    const parsed1 = parseGwtResponse(b1);
    const st = parsed1.stringTable;
    const skip = ['com.iisd', '[L', 'java.'];
    const fields = new Set(['ProdStationID','ProdID','MarkGroupStationID','MarkGroupID','ProdNum','ProdName','NewProdNum','NewProdName','AltProdMarkStationID','AltProdMarkID','AltProdNum','AltProdName','Weight','Active','ProdImage','ClientPrice','ClientPriceCurrencyID','Brand','Seats']);
    const vals = st.filter(s => !skip.some(p => s.startsWith(p)) && !fields.has(s));
    if (vals.length === 0) return [];
    
    let prodId = null, oem = null, brand = null, name = null, weight = 0;
    for (const v of vals) { if (/^\d{5,}$/.test(v)) { prodId = v; break; } }
    for (const v of vals) { if (/^[A-Z0-9\-]{5,}$/i.test(v) && !/^\d+$/.test(v)) { oem = v; break; } }
    for (let i = vals.length - 1; i >= 0; i--) { if (/^[A-Za-z][A-Za-z\s]*$/.test(vals[i]) && vals[i].length > 1) { brand = vals[i]; break; } }
    for (const v of vals) { if (/[\u0400-\u04FF]/.test(v)) { name = v; break; } }
    for (const v of vals) { if (/^0\.\d{2}$/.test(v)) weight = parseFloat(v); }
    console.log(`Thunder product: prodId=${prodId}, oem=${oem}, brand=${brand}`);
    if (!prodId) return [];
    
    // getPartAvailability
    const p2 = `7|0|5|${THUNDER_MODULE}|${THUNDER_POL_SEARCH}|com.iisd.uiw.auto.client.search.oe.s.PartSearchGWTWS|getPartAvailability|I|1|2|3|4|2|5|5|1|${prodId}|`;
    const r2 = await fetchThunder(THUNDER_GWT_PITMAX, {
      method: 'POST',
      headers: { ...THUNDER_HEADERS, 'Cookie': cookies },
      body: p2
    });
    const b2 = await r2.text();
    
    let clientPrice = 0, bestDays = null;
    if (b2.startsWith('//OK')) {
      const parsed2 = parseGwtResponse(b2);
      const avVals = parsed2.stringTable.filter(s => !skip.some(p => s.startsWith(p)));
      for (let i = 0; i < avVals.length; i++) {
        if (avVals[i] === 'Клиентска цена') {
          for (let j = i + 1; j < Math.min(i + 5, avVals.length); j++) {
            if (/^\d+\.\d+$/.test(avVals[j])) { clientPrice = parseFloat(avVals[j]); break; }
          }
        }
        if (avVals[i]?.startsWith?.('Поръчка')) {
          for (let j = i + 1; j < Math.min(i + 8, avVals.length); j++) {
            if (/^\d{1,3}$/.test(avVals[j]) && parseInt(avVals[j]) <= 365) {
              const d = parseInt(avVals[j]);
              if (bestDays === null || d < bestDays) bestDays = d;
            }
          }
        }
      }
    }
    console.log(`Thunder price: ${clientPrice}€, days: ${bestDays}`);
    
    return [{
      partNumber: oem || partNumber.toUpperCase(),
      description: name || '',
      brand: brand || '',
      weight,
      priceEUR: Math.round(clientPrice * 100) / 100,
      calculatedPrice: Math.round(clientPrice * 100) / 100,
      deliveryDays: bestDays ? `${bestDays} дни` : '15-20 дни',
      stock: 1,
      stockStatus: 'in_stock',
      source: 'thunder',
      supplierName: 'Тандер'
    }];
  } catch (err) {
    console.warn('Thunder search error:', err.message);
    return [];
  }
}

// ============ ROTINGER (SOAP API) ============
const ROTINGER_LOGIN = 'autofix_ws';
const ROTINGER_PASSWORD = 'lnQZPr51';
const ROTINGER_ENDPOINT = 'http://b2b.rotinger.pl/ProductWS/services/ProductServicePort';

async function searchRotinger(partNumber) {
  const startTime = Date.now();
  const results = [];
  
  // Clean part number - remove spaces
  const cleanPN = partNumber.replace(/\s+/g, '');
  
  // Build SOAP request with correct namespaces from WSDL
 const soapRequest = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <priceRequest xmlns="http://ws.proacta.pl/">
      <requestObject>
        <login xmlns="http://cxfservice.proacta.pl/">${ROTINGER_LOGIN}</login>
        <password xmlns="http://cxfservice.proacta.pl/">${ROTINGER_PASSWORD}</password>
        <productQuery xmlns="http://cxfservice.proacta.pl/">
          <quantity>1</quantity>
          <rotingerId>${cleanPN}</rotingerId>
        </productQuery>
      </requestObject>
    </priceRequest>
  </soap:Body>
</soap:Envelope>`;

  try {
    console.log(`Rotinger: searching for ${cleanPN}...`);
    
    const response = await fetch(ROTINGER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'urn:GetProductBrief'
      },
      body: soapRequest
    });
    
    const xmlText = await response.text();
    console.log('Rotinger response status:', response.status);
    console.log('Rotinger raw response:', xmlText.substring(0, 800));
    
    if (!response.ok) {
      console.warn(`Rotinger API error: ${response.status}`);
      return { results: [], elapsed: Date.now() - startTime, count: 0 };
    }
    
    // Parse SOAP response - handle namespaced and non-namespaced tags
    const priceMatch = xmlText.match(/<(?:ns\d*:)?price>([^<]+)<\/(?:ns\d*:)?price>/i);
    const nameMatch = xmlText.match(/<(?:ns\d*:)?name>([^<]+)<\/(?:ns\d*:)?name>/i);
    const descMatch = xmlText.match(/<(?:ns\d*:)?description>([^<]+)<\/(?:ns\d*:)?description>/i);
    const availMatch = xmlText.match(/<(?:ns\d*:)?availability>([^<]+)<\/(?:ns\d*:)?availability>/i);
    const currencyMatch = xmlText.match(/<(?:ns\d*:)?currency>([^<]+)<\/(?:ns\d*:)?currency>/i);
    const rotingerIdMatch = xmlText.match(/<(?:ns\d*:)?rotingerId>([^<]+)<\/(?:ns\d*:)?rotingerId>/i);
    
    if (priceMatch) {
      const basePrice = parseFloat(priceMatch[1]) || 0;
      
      // Apply Stefan's formula: (price + 10€)
      const costPrice = basePrice + 10;
      
      // Determine delivery based on product code
      // GL = 7-8 days, T1/T2/T3 etc = 10-12 days
      let deliveryDays = '7-8 дни';
      if (/T\d+$/i.test(cleanPN)) {
        deliveryDays = '10-12 дни';
      }
      
      // Check availability
      const availability = availMatch ? availMatch[1] : '';
      const inStock = availability.toLowerCase().includes('tak') || 
                      availability.toLowerCase().includes('yes') ||
                      parseInt(availability) > 0;
      
      results.push({
        partNumber: rotingerIdMatch ? rotingerIdMatch[1] : cleanPN,
        description: descMatch ? descMatch[1] : (nameMatch ? nameMatch[1] : 'Rotinger brake part'),
        brand: 'ROTINGER',
        priceEUR: costPrice,
        calculatedPrice: costPrice,
        originalPrice: basePrice,
        stock: inStock ? 1 : 0,
        stockStatus: inStock ? 'in_stock' : 'on_order',
        deliveryDays: deliveryDays,
        source: 'rotinger',
        supplierName: 'Rotinger',
        currency: currencyMatch ? currencyMatch[1] : 'EUR'
      });
      
      console.log(`Rotinger: ${cleanPN} → ${basePrice}€ base, ${costPrice}€ cost, delivery: ${deliveryDays}`);
    } else {
      console.log(`Rotinger: no price found for ${cleanPN}`);
    }
    
  } catch (error) {
    console.warn('Rotinger search error:', error.message);
  }
  
  return {
    results,
    elapsed: Date.now() - startTime,
    count: results.length
  };
}

// ============ UNIFIED SEARCH ENDPOINT ============
app.get('/api/supplier-search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 3) {
    return res.status(400).json({ error: 'Query must be at least 3 characters' });
  }
  
  const startTime = Date.now();
  
  // Normalize searched part number for filtering
  const searchedNormalized = q.replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase();
  
  try {
    // Get rates and APEC token in parallel
    const [rates, apecTok] = await Promise.all([
      getExchangeRates(),
      getApecToken().catch(() => null)
    ]);
    
    const deliveryPoints = apecTok ? await getApecDeliveryPoints(apecTok) : [];
    const deliveryPointID = deliveryPoints?.[0]?.DeliveryPointID ?? 0;
    
    // Search ALL suppliers in parallel (including Rotinger)
    const [impexRaw, apecRaw, emexRaw, stimoRaw, thunderRaw, rotingerRaw] = await Promise.allSettled([
      searchImpex(q),
      apecTok ? searchApec(q, apecTok, deliveryPointID) : [],
      searchEmex(q),
      searchStimo(q),
      searchThunder(q),
      searchRotinger(q)
    ]);
    
    // Transform Impex results
    const impexResults = (impexRaw.status === 'fulfilled' ? impexRaw.value : []).map(part => {
      const priceJPY = part.price_yen || 0;
      const priceEUR = priceJPY * rates.jpyToEur;
      const deliveryPrice = priceEUR * 1.47;
      const brand = part.mark || '';
      const rawPN = part.part || part.part_no_raw || '';
      const upperBrand = brand.toUpperCase();
      const formattedPN = ['HONDA','NISSAN','MITSUBISHI','SUBARU','TOYOTA'].includes(upperBrand)
        ? rawPN.replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase() : rawPN;
      
      return {
        partNumber: formattedPN,
        description: part.name_eng || part.name || '',
        originalPriceJPY: priceJPY,
        priceEUR: Math.round(priceEUR * 100) / 100,
        calculatedPrice: Math.round(deliveryPrice * 100) / 100,
        stock: part.is_discontinued ? 0 : 1,
        stockStatus: part.is_discontinued ? 'out_of_stock' : 'in_stock',
        brand: brand,
        deliveryDays: '20-25 дни',
        weight: part.weight || 0,
        source: 'impex',
        supplierName: 'Impex Japan'
      };
    });
    
    // Transform APEC results
    const APEC_DUTY = 0.05, APEC_VAT = 0.20, APEC_SHIPPING_PER_KG = 12.00;
    const apecResults = (apecRaw.status === 'fulfilled' ? apecRaw.value : []).map(item => {
      const priceUSD = item.Price || 0;
      const weightKg = item.WeightPhysical || 0.5;
      const priceEUR = priceUSD * rates.usdToEur;
      const priceWithDuty = priceEUR * (1 + APEC_DUTY);
      const shippingCost = weightKg * APEC_SHIPPING_PER_KG;
      const finalPrice = (priceWithDuty + shippingCost) * (1 + APEC_VAT);
      
      return {
        partNumber: item.PartNumber,
        description: item.PartDescription || 'Auto part',
        originalPriceUSD: priceUSD,
        priceEUR: Math.round(priceEUR * 100) / 100,
        calculatedPrice: Math.round(finalPrice * 100) / 100,
        shippingCost: Math.round(shippingCost * 100) / 100,
        stock: item.QtyInStock || item.Qty || 0,
        stockStatus: (item.QtyInStock || item.Qty || 0) > 0 ? 'in_stock' : 'on_order',
        brand: item.Brand,
        deliveryDays: `${(item.DeliveryDays || 30) + 10} дни`,
        weight: weightKg,
        source: 'apec',
        supplierName: 'APEC Dubai'
      };
    });
    
    // Transform Emex results - ONLY exact part number matches (no aftermarket/substitutes)
    const emexRawItems = emexRaw.status === 'fulfilled' ? emexRaw.value : [];
    
    // Known aftermarket brands to exclude (they use OEM numbers but are not original)
    const aftermarketBrands = ['CTR', 'CTR OEM', '555', 'FEBEST', 'MASUMA', 'GMB', 'ASHIKA', 'NIPPARTS', 'JAPANPARTS', 'BLUE PRINT', 'OPTIMAL', 'MEYLE', 'LEMFORDER', 'MOOG', 'DELPHI', 'TRW', 'SIDEM', 'RTS', 'OCAP', 'BIRTH', 'FORMPART', 'MAPCO'];
    
    // Filter: ONLY exact part number matches AND exclude aftermarket brands
    console.log('Emex raw brands:', emexRawItems.filter(i => i.number === searchedNormalized).map(i => ({ make: i.make, makeName: i.makeName, number: i.number })));
    const emexFiltered = emexRawItems.filter(item => {
      const itemNormalized = (item.number || '').replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase();
      const brandUpper = (item.make || item.makeName || '').toUpperCase();
      const isAftermarket = aftermarketBrands.some(am => brandUpper.includes(am.toUpperCase()));
      return itemNormalized === searchedNormalized && !isAftermarket;
    });
    
    // Deduplicate: keep best price per make (same number, different suppliers)
    const emexBest = new Map();
    for (const item of emexFiltered) {
      const key = item.make || 'unknown';
      const existing = emexBest.get(key);
      if (!existing || item.price < existing.price) emexBest.set(key, item);
    }
    
    const emexResults = [...emexBest.values()].map(item => {
      const priceUSD = item.price || 0;
      const weightKg = item.weight || 0.5;
      const priceEUR = priceUSD * rates.usdToEur;
      const priceWithDuty = priceEUR * (1 + APEC_DUTY);
      const shippingCost = weightKg * APEC_SHIPPING_PER_KG;
      const finalPrice = (priceWithDuty + shippingCost) * (1 + APEC_VAT);
      
      return {
        partNumber: item.number,
        description: item.name || 'Auto part',
        originalPriceUSD: priceUSD,
        priceEUR: Math.round(priceEUR * 100) / 100,
        calculatedPrice: Math.round(finalPrice * 100) / 100,
        stock: item.qty || 0,
        stockStatus: (item.qty || 0) > 0 ? 'in_stock' : 'on_order',
        brand: item.makeName || item.make,
        deliveryDays: `${(item.days || 0) + 15}-${(item.days || 0) + 22} дни`,
        weight: weightKg,
        source: 'emex',
        supplierName: 'Emex Dubai'
      };
    });
    
    // Transform Stimo results
    const stimoRawItems = stimoRaw.status === 'fulfilled' ? stimoRaw.value : [];
    const stimoResults = stimoRawItems.filter(item => item.inStock).map(item => {
      const priceEUR = item.yourPrice || 0;
      let delivery = item.deliveryDays || '-';
      if (delivery && delivery !== '-') {
        delivery = delivery.replace(/(\d+)/g, (match) => String(parseInt(match) + 2));
      } else {
        delivery = '1 ден';
      }
      if (!delivery.includes('дни') && !delivery.includes('ден')) delivery += ' дни';
      
      return {
        partNumber: item.partNumber,
        description: item.description || '',
        priceEUR: priceEUR,
        calculatedPrice: priceEUR,
        stock: 1,
        stockStatus: 'in_stock',
        brand: item.brand || '',
        deliveryDays: delivery,
        source: 'stimo',
        supplierName: 'Стимо'
      };
    });
    
    // Transform Thunder results
    const thunderRawItems = thunderRaw.status === 'fulfilled' ? thunderRaw.value : [];
    const thunderResults = thunderRawItems.map(item => ({
      partNumber: item.partNumber,
      description: item.description || '',
      priceEUR: item.priceEUR || 0,
      calculatedPrice: item.calculatedPrice || 0,
      stock: item.stock || 1,
      stockStatus: item.stockStatus || 'in_stock',
      brand: item.brand || '',
      deliveryDays: item.deliveryDays || '15-20 дни',
      weight: item.weight || 0,
      source: 'thunder',
      supplierName: 'Тандер'
    }));
    
    // Transform Rotinger results
    const rotingerData = rotingerRaw.status === 'fulfilled' ? rotingerRaw.value : { results: [] };
    const rotingerResults = rotingerData.results || [];
    
    // Combine and sort
    const allResults = [...impexResults, ...apecResults, ...emexResults, ...stimoResults, ...thunderResults, ...rotingerResults];
    allResults.sort((a, b) => (a.calculatedPrice || 0) - (b.calculatedPrice || 0));
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Search: ${q} → ${impexResults.length} Impex + ${apecResults.length} APEC + ${emexResults.length} Emex (filtered from ${emexRawItems.length}) + ${stimoResults.length} Stimo + ${thunderResults.length} Thunder + ${rotingerResults.length} Rotinger in ${elapsed}ms`);
    
    res.json({
      success: true,
      query: q,
      impexCount: impexResults.length,
      apecCount: apecResults.length,
      emexCount: emexResults.length,
      emexRawCount: emexRawItems.length,
      stimoCount: stimoResults.length,
      thunderCount: thunderResults.length,
      rotingerCount: rotingerResults.length,
      totalCount: allResults.length,
      elapsed,
      rates,
      results: allResults.slice(0, 60)
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    caches: {
      rates: !!cachedRates,
      apec: !!apecToken,
      emex: !!emexCid,
      stimo: !!stimoCookies,
      thunder: !!thunderCookies
    }
  });
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`🚀 AutoFix API running on port ${PORT}`);
});
