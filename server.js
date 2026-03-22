// AutoFix API Backend — Express Server for Railway
// All suppliers: Impex, APEC, Emex, Stimo, Thunder, AutoHelp (Playwright)

const express = require('express');
const cors = require('cors');
const https = require('https');
const nodeFetch = require('node-fetch');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const fetchThunder = (url, options = {}) => nodeFetch(url, { ...options, agent: httpsAgent });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ============ CACHES ============
let cachedRates = null, ratesExpiry = null;
let apecToken = null, apecTokenExpiry = null, apecDeliveryPoints = null;
let emexCid = null, emexLoginTime = null;
let stimoCookies = null, stimoLoginTime = null;
let thunderCookies = null, thunderSessionExpiry = null;

// ============ EXCHANGE RATES ============
async function getExchangeRates() {
  if (cachedRates && ratesExpiry && Date.now() < ratesExpiry) return cachedRates;
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=EUR&to=JPY,USD');
    const data = await response.json();
    if (data.rates) {
      cachedRates = { jpyToEur: 1 / data.rates.JPY, usdToEur: 1 / data.rates.USD };
      ratesExpiry = Date.now() + 12 * 60 * 60 * 1000;
      return cachedRates;
    }
  } catch (err) { console.warn('Exchange rate fetch failed:', err.message); }
  return cachedRates || { jpyToEur: 0.0061, usdToEur: 0.92 };
}

// ============ IMPEX JAPAN ============
async function searchImpex(partNumber) {
  const params = new URLSearchParams({ key: '-EoJIknVUaTUeo8Jk6bV', part_no: partNumber, original_only: '0', price_factor: '1', price_increase: '0' });
  const response = await fetch(`https://www.impex-jp.com/api/parts/search.html?${params}`, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) return [];
  const data = await response.json();
  return data.original_parts || [];
}

// ============ APEC DUBAI ============
async function getApecToken() {
  if (apecToken && apecTokenExpiry && Date.now() < apecTokenExpiry - 300000) return apecToken;
  const username = process.env.APEC_USERNAME, password = process.env.APEC_PASSWORD;
  if (!username || !password) throw new Error('APEC credentials not configured');
  const response = await fetch('https://api.apecauto.com/token', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&grant_type=password` });
  if (!response.ok) throw new Error(`APEC auth failed: ${response.status}`);
  const data = await response.json();
  apecToken = data.access_token;
  apecTokenExpiry = Date.now() + (data.expires_in * 1000);
  return apecToken;
}

async function getApecDeliveryPoints(token) {
  if (apecDeliveryPoints) return apecDeliveryPoints;
  const response = await fetch('https://api.apecauto.com/api/getdeliverypoints', { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) return [];
  apecDeliveryPoints = await response.json();
  return apecDeliveryPoints;
}

async function searchApec(partNumber, token, deliveryPointID) {
  const cleanPN = partNumber.replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase();
  const brandsResp = await fetch(`https://api.apecauto.com/api/search/${encodeURIComponent(cleanPN)}/brands?analogues=false&deliveryPointID=${deliveryPointID}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!brandsResp.ok) return [];
  const brands = await brandsResp.json();
  if (!brands || brands.length === 0) return [];
  const batchBody = brands.slice(0, 3).map(b => ({ PartNumber: cleanPN, Brand: b.Brand }));
  const searchResp = await fetch(`https://api.apecauto.com/api/search?deliveryPointID=${deliveryPointID}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batchBody) });
  if (!searchResp.ok) return [];
  const data = await searchResp.json();
  return (Array.isArray(data) ? data : []).filter(item => item.Price != null && item.Price > 0);
}

// ============ EMEX DUBAI ============
const EMEX_SOAP_URL = 'https://soap.emexdwc.ae/service.asmx';
const EMEX_NS = 'https://soap.emexdwc.ae/';
const EMEX_USER = process.env.EMEX_USER || 'QCJD';
const EMEX_PASS = process.env.EMEX_PASS || 'Banskolesi123!';

function escXml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function soapEnvelope(body) { return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`; }
async function soapCall(action, body) {
  const resp = await fetch(EMEX_SOAP_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"${EMEX_NS}${action}"` }, body: soapEnvelope(body) });
  return await resp.text();
}
function xv(xml, tag) { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')); return m ? m[1] : null; }
function xAll(xml, tag) { const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'); const out = []; let m; while ((m = re.exec(xml)) !== null) out.push(m[1]); return out; }

async function emexLogin() {
  if (emexCid && emexLoginTime && (Date.now() - emexLoginTime < 30 * 60 * 1000)) return emexCid;
  const xml = await soapCall('Login', `<Login xmlns="${EMEX_NS}"><Customer><UserName>${escXml(EMEX_USER)}</UserName><Password>${escXml(EMEX_PASS)}</Password></Customer></Login>`);
  const cid = xv(xml, 'CustomerId');
  if (!cid || cid === '0') throw new Error(xv(xml, 'faultstring') || 'Emex login failed');
  emexCid = cid; emexLoginTime = Date.now();
  return cid;
}

async function searchEmex(partNumber) {
  try {
    const cid = await emexLogin();
    const xml = await soapCall('SearchPartEx', `<SearchPartEx xmlns="${EMEX_NS}"><Customer><UserName>${escXml(EMEX_USER)}</UserName><Password>${escXml(EMEX_PASS)}</Password><CustomerId>${cid}</CustomerId></Customer><DetailNum>${escXml(partNumber)}</DetailNum><ShowSubsts>false</ShowSubsts></SearchPartEx>`);
    const items = xAll(xml, 'FindByNumber');
    return items.map(item => ({ make: xv(item, 'Make') || '', makeName: xv(item, 'MakeName') || '', number: xv(item, 'DetailNum') || '', name: xv(item, 'PartNameEng') || xv(item, 'PartNameRus') || '', price: parseFloat(xv(item, 'Price') || '0'), days: parseInt(xv(item, 'Delivery') || '0'), qty: parseInt(xv(item, 'Available') || '0'), weight: parseFloat(xv(item, 'WeightGr') || '0') / 1000, percentSupplied: parseInt(xv(item, 'PercentSupped') || '0') })).filter(item => item.price > 0);
  } catch (err) { console.warn('Emex search error:', err.message); return []; }
}

// ============ STIMO ============
const STIMO_BASE = 'https://dealers.oemjapanparts.com';
const STIMO_EMAIL = process.env.STIMO_EMAIL || 'autofixparts24@gmail.com';
const STIMO_PASS_ENV = process.env.STIMO_PASS || '11112222';

function extractCookies(headers) {
  const raw = headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(/,(?=[^ ])/).map(c => c.split(';')[0].trim()).filter(c => c.includes('=')).join('; ');
}
function mergeCookies(a, b) {
  if (!b) return a || ''; if (!a) return b;
  const m = {};
  a.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) m[k.trim()] = v.join('='); });
  b.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) m[k.trim()] = v.join('='); });
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function stimoLogin() {
  if (stimoCookies && stimoLoginTime && (Date.now() - stimoLoginTime < 25 * 60 * 1000)) return stimoCookies;
  let cookies = '';
  try { const homeResp = await fetch(`${STIMO_BASE}/`, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' }); cookies = extractCookies(homeResp.headers); } catch (e) {}
  const loginResp = await fetch(`${STIMO_BASE}/login.html`, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${STIMO_BASE}/`, 'Cookie': cookies }, body: new URLSearchParams({ info: '', email: STIMO_EMAIL, pass: STIMO_PASS_ENV }).toString(), redirect: 'manual' });
  cookies = mergeCookies(cookies, extractCookies(loginResp.headers));
  const location = loginResp.headers.get('location');
  if (location) { const redirectUrl = location.startsWith('http') ? location : `${STIMO_BASE}/${location.replace(/^\//, '')}`; const redirectResp = await fetch(redirectUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies }, redirect: 'manual' }); cookies = mergeCookies(cookies, extractCookies(redirectResp.headers)); }
  stimoCookies = cookies; stimoLoginTime = Date.now();
  return cookies;
}

function stripTags(html) { return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€').replace(/&#?\w+;/g, '').replace(/\s+/g, ' ').trim(); }
function parsePrice(str) { if (!str) return 0; const cleaned = str.replace(/[€\s]/g, '').replace(',', '.'); const num = parseFloat(cleaned); return isNaN(num) ? 0 : Math.round(num * 100) / 100; }

async function searchStimo(partNumber) {
  try {
    const cookies = await stimoLogin();
    const pn = partNumber.replace(/[\s-]/g, '');
    const searchResp = await fetch(`${STIMO_BASE}/advsearch.html?search_type=full&partnums=${encodeURIComponent(pn.toLowerCase())}&submit=1`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookies } });
    if (!searchResp.ok) return [];
    const html = await searchResp.text();
    if (html.includes('ВХОД ЗА КЛИЕНТИ') && !html.includes('ИЗТОЧНИК')) { stimoCookies = null; return []; }
    const results = [];
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const [, source, oeNumber, description, brand, priceWithVat, yourPrice, availability, deliveryTime] = match;
      const cleanOe = stripTags(oeNumber).trim();
      if (cleanOe.toLowerCase() === 'ое номер' || !cleanOe) continue;
      results.push({ source: stripTags(source).trim(), partNumber: cleanOe, description: stripTags(description).trim(), brand: stripTags(brand).trim(), priceWithVat: parsePrice(stripTags(priceWithVat)), yourPrice: parsePrice(stripTags(yourPrice)), inStock: !availability.includes('Nopresent') && !stripTags(availability).includes('---'), deliveryDays: stripTags(deliveryTime).trim() || '-' });
    }
    return results;
  } catch (err) { console.warn('Stimo search error:', err.message); return []; }
}

// ============ THUNDER ============
const THUNDER_BASE = 'https://pitmaxauto.com';
const THUNDER_GWT_USER = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/GWTWebServiceUser`;
const THUNDER_GWT_PITMAX = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/GWTWebServicePITMax`;
const THUNDER_MODULE = `${THUNDER_BASE}/com.iisd.uiw.pm.Start/`;
const THUNDER_PERM = '70709A8D465EC375F1DBE979394D3AB3';
const THUNDER_POL_LOGIN = 'CBA32746B023408F8C29D3768C24D68B';
const THUNDER_POL_SEARCH = '48FDBB0C1ABD9AB543E5F4D21ABEB03D';
const THUNDER_USER = process.env.THUNDER_USER || 'autofix.parts';
const THUNDER_PASS = process.env.THUNDER_PASS || '414001';
const THUNDER_HEADERS = { 'Content-Type': 'text/x-gwt-rpc; charset=UTF-8', 'X-GWT-Module-Base': THUNDER_MODULE, 'X-GWT-Permutation': THUNDER_PERM, 'Origin': THUNDER_BASE, 'Referer': `${THUNDER_BASE}/`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function parseGwtResponse(text) {
  if (text.startsWith('//EX')) throw new Error('GWT Exception');
  if (!text.startsWith('//OK')) throw new Error('Bad GWT response');
  const content = text.substring(4);
  const lastBracket = content.lastIndexOf('["');
  if (lastBracket === -1) return { stringTable: [] };
  let depth = 0, end = -1;
  for (let i = lastBracket; i < content.length; i++) { if (content[i] === '[') depth++; else if (content[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } } }
  if (end === -1) end = content.length;
  try { return { stringTable: JSON.parse(content.substring(lastBracket, end)) }; }
  catch (e) { const strings = []; const re = /"((?:[^"\\]|\\.)*)"/g; let m; while ((m = re.exec(content)) !== null) strings.push(m[1]); return { stringTable: strings }; }
}

async function thunderLogin() {
  if (thunderCookies && thunderSessionExpiry && Date.now() < thunderSessionExpiry) return thunderCookies;
  let cookies = '';
  try { const r = await fetchThunder(THUNDER_BASE, { headers: { 'User-Agent': THUNDER_HEADERS['User-Agent'] } }); const setCookie = r.headers.get('set-cookie'); if (setCookie) cookies = setCookie.split(';')[0]; } catch (e) {}
  const payload = `7|0|7|${THUNDER_MODULE}|${THUNDER_POL_LOGIN}|com.iisd.uiw.um.client.user.s.UserGWTWS|login|java.lang.String/2004016611|${THUNDER_USER}|${THUNDER_PASS}|1|2|3|4|2|5|5|6|7|`;
  const resp = await fetchThunder(THUNDER_GWT_USER, { method: 'POST', headers: { ...THUNDER_HEADERS, 'Cookie': cookies }, body: payload });
  const newCookies = resp.headers.get('set-cookie');
  if (newCookies) cookies = mergeCookies(cookies, newCookies.split(';')[0]);
  const body = await resp.text();
  if (!body.startsWith('//OK')) throw new Error('Thunder login failed');
  thunderCookies = cookies; thunderSessionExpiry = Date.now() + 30 * 60 * 1000;
  return cookies;
}

async function searchThunder(partNumber) {
  try {
    const cookies = await thunderLogin();
    const pn = partNumber.toLowerCase();
    const p1 = `7|0|12|${THUNDER_MODULE}|${THUNDER_POL_SEARCH}|com.iisd.uiw.auto.client.search.oe.s.PartSearchGWTWS|getManyParts|com.iisd.fw.data.IISDResultSetDef/4116809468|[Lcom.iisd.fw.data.IISDResultSetFilterDef;/1103246466|com.iisd.fw.data.IISDResultSetFilterDef/3152666539|MarkGroupStationID|0|MarkGroupID|ProdNum|${pn}|1|2|3|4|1|5|5|2|0|0|6|3|7|0|8|0|0|0|9|7|0|10|0|0|0|9|7|0|11|0|0|2|12|0|0|30|`;
    const r1 = await fetchThunder(THUNDER_GWT_PITMAX, { method: 'POST', headers: { ...THUNDER_HEADERS, 'Cookie': cookies }, body: p1 });
    const b1 = await r1.text();
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
    if (!prodId) return [];
    const p2 = `7|0|5|${THUNDER_MODULE}|${THUNDER_POL_SEARCH}|com.iisd.uiw.auto.client.search.oe.s.PartSearchGWTWS|getPartAvailability|I|1|2|3|4|2|5|5|1|${prodId}|`;
    const r2 = await fetchThunder(THUNDER_GWT_PITMAX, { method: 'POST', headers: { ...THUNDER_HEADERS, 'Cookie': cookies }, body: p2 });
    const b2 = await r2.text();
    let clientPrice = 0, bestDays = null;
    const options = [];
    if (b2.startsWith('//OK')) {
      const parsed2 = parseGwtResponse(b2);
      const avVals = parsed2.stringTable.filter(s => !skip.some(p => s.startsWith(p)));
      const labels = new Set(['Поръчка','Клиентска цена','Поръчка 1','Поръчка 2','Поръчка 10']);
      for (let i = 0; i < avVals.length; i++) {
        if (labels.has(avVals[i])) {
          const label = avVals[i]; let price = 0, days = null;
          for (let j = i + 1; j < Math.min(i + 8, avVals.length); j++) {
            if (labels.has(avVals[j])) break;
            if (/^\d+\.\d+$/.test(avVals[j]) && !price) price = parseFloat(avVals[j]);
            else if (/^\d{1,3}$/.test(avVals[j]) && parseInt(avVals[j]) <= 365 && days === null) days = parseInt(avVals[j]);
          }
          if (price > 0) options.push({ label, price, days });
        }
      }
      if (options.length > 0) { const cheapest = options.reduce((a, b) => a.price < b.price ? a : b); clientPrice = cheapest.price; bestDays = cheapest.days; }
    }
    const results = [];
    const byPrice = [...options].sort((a, b) => a.price - b.price);
    const byDays = [...options].filter(o => o.days !== null).sort((a, b) => a.days - b.days);
    const cheapest = byPrice[0], fastest = byDays[0];
    if (cheapest) results.push({ partNumber: oem || partNumber.toUpperCase(), description: name || '', brand: brand || '', weight, priceEUR: Math.round(cheapest.price * 100) / 100, calculatedPrice: Math.round(cheapest.price * 100) / 100, deliveryDays: `${(cheapest.days || 15) + 2} дни`, stock: 1, stockStatus: 'in_stock', source: 'thunder', supplierName: 'Тандер', thunderOption: cheapest.label });
    if (fastest && cheapest && fastest.label !== cheapest.label && fastest.days < (cheapest.days || 999)) results.push({ partNumber: oem || partNumber.toUpperCase(), description: name || '', brand: brand || '', weight, priceEUR: Math.round(fastest.price * 100) / 100, calculatedPrice: Math.round(fastest.price * 100) / 100, deliveryDays: `${(fastest.days || 11) + 2} дни`, stock: 1, stockStatus: 'in_stock', source: 'thunder', supplierName: 'Тандер (бърза)', thunderOption: fastest.label });
    if (results.length === 0 && clientPrice > 0) results.push({ partNumber: oem || partNumber.toUpperCase(), description: name || '', brand: brand || '', weight, priceEUR: Math.round(clientPrice * 100) / 100, calculatedPrice: Math.round(clientPrice * 100) / 100, deliveryDays: `${(bestDays || 15) + 2} дни`, stock: 1, stockStatus: 'in_stock', source: 'thunder', supplierName: 'Тандер' });
    return results;
  } catch (err) { console.warn('Thunder search error:', err.message); return []; }
}

// ============ AUTOHELP — Playwright ============
const AH_BASE = 'https://eshop.autohelp.bg/Eshop';
const AH_USER = process.env.AUTOHELP_USER || 'MM1441';
const AH_PASS = process.env.AUTOHELP_PASS || 'MM1441';
const AH_CAPTCHA_KEY = (process.env.TWOCAPTCHA_KEY || '').trim();

let ahBrowser = null;
let ahPage = null;
let ahLoggedIn = false;
let ahLoginTime = 0;
const AH_TTL = 25 * 60 * 1000;

async function ahSolve2captcha(buffer) {
  const base64 = buffer.toString('base64');
  const boundary = '----AHBoundary' + Date.now();
  const body = [
    `--${boundary}`, 'Content-Disposition: form-data; name="key"', '', AH_CAPTCHA_KEY,
    `--${boundary}`, 'Content-Disposition: form-data; name="method"', '', 'base64',
    `--${boundary}`, 'Content-Disposition: form-data; name="body"', '', base64,
    `--${boundary}`, 'Content-Disposition: form-data; name="case"', '', '1',
    `--${boundary}`, 'Content-Disposition: form-data; name="min_len"', '', '4',
    `--${boundary}`, 'Content-Disposition: form-data; name="max_len"', '', '8',
    `--${boundary}--`, ''
  ].join('\r\n');

  const sub = await nodeFetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  const subText = await sub.text();
  console.log(`2captcha submit: "${subText}"`);
  if (!subText.startsWith('OK|')) throw new Error(`2captcha: ${subText}`);
  const id = subText.split('|')[1].trim();

  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await nodeFetch(`https://2captcha.com/res.php?key=${AH_CAPTCHA_KEY}&action=get&id=${id}`);
    const text = await poll.text();
    if (text.startsWith('OK|')) { console.log(`2captcha solved: "${text.split('|')[1]}"`); return text.split('|')[1].trim(); }
    if (text !== 'CAPCHA_NOT_READY') throw new Error(`2captcha: ${text}`);
  }
  throw new Error('2captcha timeout');
}

async function getAhPage() {
  if (ahPage && ahLoggedIn && Date.now() - ahLoginTime < AH_TTL) {
    // Verify session still active
    try {
      const url = ahPage.url();
      if (!url.includes('Login')) return ahPage;
    } catch {}
  }

  // Close old browser
  if (ahBrowser) { try { await ahBrowser.close(); } catch {} ahBrowser = null; ahPage = null; }

  const { chromium } = require('playwright');

// Anti-detection: inject stealth scripts
async function applyStealthScripts(page) {
  await page.addInitScript(() => {
    // Override webdriver detection
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Override plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    // Override languages
    Object.defineProperty(navigator, 'languages', { get: () => ['bg-BG', 'bg', 'en-US', 'en'] });
    // Override chrome
    window.chrome = { runtime: {} };
    // Override permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });
}
  ahBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-http2'] });
  const ctx = await ahBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    },
  });
  ahPage = await ctx.newPage();
  await applyStealthScripts(ahPage);

  console.log('AutoHelp: fetching login page for CAPTCHA...');
  // Use fetch to get the login page HTML and CAPTCHA
  const loginUrl = `${AH_BASE}/Login.aspx?cookieCheck=true`;
  const baseHdrs = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'bg-BG,bg;q=0.9' };

  // GET login page via fetch to get cookies + ViewState
  const r0 = await fetch(loginUrl, { headers: baseHdrs, redirect: 'follow' });
  let fetchCookies = {};
  for (const c of (r0.headers.raw ? r0.headers.raw()['set-cookie'] || [] : [])) {
    const [kv] = c.split(';'); const eq = kv.indexOf('=');
    if (eq > 0) fetchCookies[kv.slice(0,eq).trim()] = kv.slice(eq+1).trim();
  }
  const r1 = await fetch(`${AH_BASE}/Login.aspx`, { headers: { ...baseHdrs, Cookie: Object.entries(fetchCookies).map(([k,v])=>`${k}=${v}`).join('; ') }, redirect: 'follow' });
  for (const c of (r1.headers.raw ? r1.headers.raw()['set-cookie'] || [] : [])) {
    const [kv] = c.split(';'); const eq = kv.indexOf('=');
    if (eq > 0) fetchCookies[kv.slice(0,eq).trim()] = kv.slice(eq+1).trim();
  }
  const html1 = await r1.text();

  // Extract ViewState
  const aspFields = {};
  for (const id of ['__VIEWSTATE','__VIEWSTATEGENERATOR','__EVENTVALIDATION','__LASTFOCUS']) {
    const m = html1.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
    if (m) aspFields[id] = m[1];
  }

  // Find CAPTCHA URL
  const captchaMatch = html1.match(/src="(AntiBotPicture\.ashx[^"]*)"/i);
  if (!captchaMatch) throw new Error('CAPTCHA not found in login page');
  const captchaUrl = `https://eshop.autohelp.bg/Eshop/${captchaMatch[1]}`;

  // Download CAPTCHA via fetch
  const imgResp = await fetch(captchaUrl, { headers: { ...baseHdrs, Cookie: Object.entries(fetchCookies).map(([k,v])=>`${k}=${v}`).join('; ') } });
  for (const c of (imgResp.headers.raw ? imgResp.headers.raw()['set-cookie'] || [] : [])) {
    const [kv] = c.split(';'); const eq = kv.indexOf('=');
    if (eq > 0) fetchCookies[kv.slice(0,eq).trim()] = kv.slice(eq+1).trim();
  }
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
  console.log(`AutoHelp: CAPTCHA fetched, size=${imgBuffer.length}`);

  const captchaText = await ahSolve2captcha(imgBuffer);
  console.log(`AutoHelp: CAPTCHA solved = "${captchaText}"`);

  // POST login via fetch
  const cookieString = Object.entries(fetchCookies).map(([k,v])=>`${k}=${v}`).join('; ');
  const loginBody = new URLSearchParams({
    __LASTFOCUS: aspFields.__LASTFOCUS || '',
    __EVENTTARGET: '', __EVENTARGUMENT: '',
    __VIEWSTATE: aspFields.__VIEWSTATE || '',
    __VIEWSTATEGENERATOR: aspFields.__VIEWSTATEGENERATOR || '',
    __EVENTVALIDATION: aspFields.__EVENTVALIDATION || '',
    'ctl00$ContentPlaceHolder1$Login1$UserName': AH_USER,
    'ctl00$ContentPlaceHolder1$Login1$Password': AH_PASS,
    'ctl00$ContentPlaceHolder1$Login1$txtEnterPicLogin': captchaText,
    'ctl00$ContentPlaceHolder1$Login1$LoginButton.x': '35',
    'ctl00$ContentPlaceHolder1$Login1$LoginButton.y': '12',
  });

  const r2 = await fetch(loginUrl, {
    method: 'POST',
    headers: { ...baseHdrs, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieString, Referer: loginUrl, Origin: 'https://eshop.autohelp.bg' },
    body: loginBody.toString(),
    redirect: 'manual',
  });
  for (const c of (r2.headers.raw ? r2.headers.raw()['set-cookie'] || [] : [])) {
    const [kv] = c.split(';'); const eq = kv.indexOf('=');
    if (eq > 0) fetchCookies[kv.slice(0,eq).trim()] = kv.slice(eq+1).trim();
  }
  const loc = r2.headers.get('location') || '';
  if (r2.status !== 302 && !loc) throw new Error(`Login POST failed: status=${r2.status}`);

  // Follow redirect
  if (loc) {
    const redirUrl = loc.startsWith('http') ? loc : `https://eshop.autohelp.bg${loc}`;
    const r3 = await fetch(redirUrl, { headers: { ...baseHdrs, Cookie: Object.entries(fetchCookies).map(([k,v])=>`${k}=${v}`).join('; ') } });
    for (const c of (r3.headers.raw ? r3.headers.raw()['set-cookie'] || [] : [])) {
      const [kv] = c.split(';'); const eq = kv.indexOf('=');
      if (eq > 0) fetchCookies[kv.slice(0,eq).trim()] = kv.slice(eq+1).trim();
    }
  }

  // Store cookies in Playwright context for consistency
  const cookiesArray = Object.entries(fetchCookies).map(([name, value]) => ({ name, value, domain: 'eshop.autohelp.bg', path: '/' }));
  await ahPage.context().addCookies(cookiesArray);

  const finalUrl = loc || 'logged-in';
  if (finalUrl.includes('Login')) {
    ahLoggedIn = false;
    throw new Error('Login failed — wrong CAPTCHA or credentials');
  }

  ahLoggedIn = true;
  ahLoginTime = Date.now();
  console.log(`AutoHelp: ✅ logged in, url=${finalUrl}`);
  return ahPage;
}

async function ahSearchPlaywright(partNumber) {
  // Get session cookies from Playwright
  const page = await getAhPage();
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Use fetch with Playwright cookies — Railway can reach the site fine
  const searchUrl = `${AH_BASE}/Products.aspx?MultiView=0&Category=${encodeURIComponent('в Артикул код')}&SearchString=${encodeURIComponent(partNumber)}`;

  console.log(`AutoHelp: searching ${partNumber} via fetch with ${cookies.length} cookies...`);
  const r = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Cookie': cookieStr,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.8',
      'Referer': `${AH_BASE}/Products.aspx`,
    },
    redirect: 'follow',
  });

  const html = await r.text();
  console.log(`AutoHelp: got ${html.length} bytes`);

  // If session expired, clear and retry once
  if (html.includes('Login.aspx') || html.includes('txtEnterPicLogin')) {
    console.log('AutoHelp: session expired, re-logging...');
    ahLoggedIn = false;
    if (ahBrowser) { try { await ahBrowser.close(); } catch {} ahBrowser = null; ahPage = null; }
    return ahSearchPlaywright(partNumber);
  }

  return parseAhResults(html, partNumber);
}

function parseAhResults(html, query) {
  const results = [];
  const norm = s => s.replace(/[-\s]/g, '').toUpperCase();

  // Find all hidden id fields — these mark product rows
  const idMatches = [...html.matchAll(/id="id_hid(\d+)"[^>]*value="(\d+)"/gi)];

  if (idMatches.length === 0) {
    // Fallback: parse table rows
    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const r = row[1];
      if (/<th/i.test(r)) continue;
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()).filter(Boolean);
      if (cells.length < 3) continue;
      const priceCell = cells.find(c => /\d+[.,]\d{2}/.test(c) && c.length < 30);
      if (!priceCell) continue;
      const price = parseFloat(priceCell.match(/(\d+[.,]\d{2})/)[1].replace(',', '.'));
      if (!price || price < 0.1) continue;
      const codeCell = cells.find(c => /^[A-Z0-9][\w\-\.\/]{3,24}$/i.test(c) && c !== priceCell);
      const descCell = cells.find(c => c !== priceCell && c !== codeCell && c.length > 3 && !/^\d+[.,]?\d*$/.test(c));
      results.push({ partNumber: codeCell || query, description: descCell || '', price, currency: 'EUR', source: 'autohelp', supplierName: 'AutoHelp' });
    }
    return results;
  }

  // Use id_hid markers to find product data
  for (const m of idMatches) {
    const index = m[1];
    const itemId = m[2];

    // Find price near this index
    const idPos = html.indexOf(`id="id_hid${index}"`);
    const nextIdPos = html.indexOf(`id="id_hid${parseInt(index) + 1}"`, idPos);
    const segment = nextIdPos > 0 ? html.slice(idPos, nextIdPos) : html.slice(idPos, idPos + 3000);

    // Extract code
    const codeMatch = segment.match(/>[A-Z]{1,5}\s*[A-Z0-9\-\.\/]{3,20}</i);
    // Extract price EUR
    const priceMatch = segment.match(/(\d+[.,]\d{2})\s*(?:&euro;|€|EUR|лв)/i);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1].replace(',', '.'));
    if (!price) continue;

    // Extract description
    const descMatch = segment.match(/class="[^"]*[Dd]esc[^"]*"[^>]*>([^<]{3,80})</i)
      || segment.match(/<td[^>]*>([А-Яа-яA-Za-z][^<]{5,60})<\/td>/);

    results.push({
      partNumber: codeMatch ? codeMatch[0].replace(/[><]/g, '').trim() : query,
      description: descMatch ? descMatch[1].trim() : '',
      price,
      currency: /лв/i.test(priceMatch[0]) ? 'BGN' : 'EUR',
      itemId,
      inStock: true,
      source: 'autohelp',
      supplierName: 'AutoHelp',
    });
  }

  return results;
}

// ============ AUTOHELP ENDPOINT ============
app.post('/api/autohelp-search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { action, partNumber } = req.body || {};

  try {
    if (action === 'session_status') {
      return res.json({
        active: ahLoggedIn && Date.now() - ahLoginTime < AH_TTL,
        ageSeconds: ahLoggedIn ? Math.round((Date.now() - ahLoginTime) / 1000) : null,
        expiresInSeconds: ahLoggedIn ? Math.max(0, Math.round((AH_TTL - (Date.now() - ahLoginTime)) / 1000)) : null,
      });
    }

    if (action === 'login') {
      ahLoggedIn = false;
      if (ahBrowser) { try { await ahBrowser.close(); } catch {} ahBrowser = null; ahPage = null; }
      await getAhPage();
      return res.json({ ok: true, message: '✅ Логинът е успешен!' });
    }

    if (action === 'search') {
      if (!partNumber) return res.status(400).json({ ok: false, error: 'Липсва partNumber' });
      const results = await ahSearchPlaywright(partNumber);
      return res.json({ ok: true, results, count: results.length });
    }

    if (action === 'debug_search') {
      if (!partNumber) return res.status(400).json({ ok: false, error: 'Липсва partNumber' });
      const page = await getAhPage();
      const searchUrl = `${AH_BASE}/Products.aspx?MultiView=0&Category=${encodeURIComponent('в Артикул код')}&SearchString=${encodeURIComponent(partNumber)}`;
      // Intercept response to get raw HTML
      let rawResponseBody = '';
      page.on('response', async response => {
        if (response.url().includes('Products.aspx') && response.request().method() === 'GET') {
          try { rawResponseBody = await response.text(); } catch {}
        }
      });

      await page.goto(searchUrl, { waitUntil: 'load', timeout: 25000 });
      await page.waitForTimeout(3000);

      const html = await page.content();
      const idHidAt = html.indexOf('id_hid');
      const rawIdHidAt = rawResponseBody.indexOf('id_hid');

      // Get all cookies
      const cookies = await page.context().cookies();
      const cookieNames = cookies.map(c => c.name + '=' + c.value.slice(0,20));
      const hasEshopCookie = cookies.some(c => c.name === 'eshop');

      return res.json({
        ok: true,
        playwrightHtmlLen: html.length,
        rawResponseLen: rawResponseBody.length,
        idHidInPlaywright: idHidAt > 0,
        idHidInRaw: rawIdHidAt > 0,
        hasEshopCookie,
        cookieCount: cookies.length,
        cookieNames,
        htmlMiddle: html.slice(Math.floor(html.length/2), Math.floor(html.length/2) + 2000),
      });
    }

    return res.status(400).json({ error: 'Използвай: login, search, session_status' });
  } catch (err) {
    ahLoggedIn = false;
    console.error('AutoHelp error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ UNIFIED SEARCH ENDPOINT ============
app.get('/api/supplier-search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 3) return res.status(400).json({ error: 'Query must be at least 3 characters' });
  const startTime = Date.now();
  try {
    const [rates, apecTok] = await Promise.all([getExchangeRates(), getApecToken().catch(() => null)]);
    const deliveryPoints = apecTok ? await getApecDeliveryPoints(apecTok) : [];
    const deliveryPointID = deliveryPoints?.[0]?.DeliveryPointID ?? 0;
    const [impexRaw, apecRaw, emexRaw, stimoRaw, thunderRaw] = await Promise.allSettled([searchImpex(q), apecTok ? searchApec(q, apecTok, deliveryPointID) : [], searchEmex(q), searchStimo(q), searchThunder(q)]);
    const impexResults = (impexRaw.status === 'fulfilled' ? impexRaw.value : []).map(part => { const priceJPY = part.price_yen || 0; const priceEUR = priceJPY * rates.jpyToEur; const deliveryPrice = priceEUR * 1.47; const brand = part.mark || ''; const rawPN = part.part || part.part_no_raw || ''; const formattedPN = ['HONDA','NISSAN','MITSUBISHI','SUBARU','TOYOTA'].includes(brand.toUpperCase()) ? rawPN.replace(/[\s\-\.\/\\,;:_]+/g, '').toUpperCase() : rawPN; return { partNumber: formattedPN, description: part.name_eng || part.name || '', originalPriceJPY: priceJPY, priceEUR: Math.round(priceEUR * 100) / 100, calculatedPrice: Math.round(deliveryPrice * 100) / 100, stock: part.is_discontinued ? 0 : 1, stockStatus: part.is_discontinued ? 'out_of_stock' : 'in_stock', brand, deliveryDays: '20-25 дни', weight: part.weight || 0, source: 'impex', supplierName: 'Impex Japan' }; });
    const APEC_DUTY = 0.05, APEC_SHIPPING_PER_KG = 6.50;
    const apecResults = (apecRaw.status === 'fulfilled' ? apecRaw.value : []).map(item => { const priceUSD = item.Price || 0; const weightKg = item.WeightPhysical || 0.5; const priceEUR = priceUSD * rates.usdToEur; const finalPrice = priceEUR * (1 + APEC_DUTY) + weightKg * APEC_SHIPPING_PER_KG; return { partNumber: item.PartNumber, description: item.PartDescription || 'Auto part', originalPriceUSD: priceUSD, priceEUR: Math.round(priceEUR * 100) / 100, calculatedPrice: Math.round(finalPrice * 100) / 100, shippingCost: Math.round(weightKg * APEC_SHIPPING_PER_KG * 100) / 100, stock: item.QtyInStock || item.Qty || 0, stockStatus: (item.QtyInStock || item.Qty || 0) > 0 ? 'in_stock' : 'on_order', brand: item.Brand, deliveryDays: `${(item.DeliveryDays || 30) + 10} дни`, weight: weightKg, source: 'apec', supplierName: 'APEC Dubai' }; });
    const emexRawItems = emexRaw.status === 'fulfilled' ? emexRaw.value : [];
    const emexBest = new Map();
    for (const item of emexRawItems) { const key = `${item.make}_${item.number}`; const existing = emexBest.get(key); if (!existing || item.price < existing.price) emexBest.set(key, item); }
    const emexResults = [...emexBest.values()].map(item => { const priceUSD = item.price || 0; const weightKg = item.weight || 0.5; const priceEUR = priceUSD * rates.usdToEur; const finalPrice = priceEUR * (1 + APEC_DUTY) + weightKg * APEC_SHIPPING_PER_KG; return { partNumber: item.number, description: item.name || 'Auto part', originalPriceUSD: priceUSD, priceEUR: Math.round(priceEUR * 100) / 100, calculatedPrice: Math.round(finalPrice * 100) / 100, stock: item.qty || 0, stockStatus: (item.qty || 0) > 0 ? 'in_stock' : 'on_order', brand: item.makeName || item.make, deliveryDays: `${(item.days || 0) + 15}-${(item.days || 0) + 22} дни`, weight: weightKg, source: 'emex', supplierName: 'Emex Dubai' }; });
    const stimoResults = (stimoRaw.status === 'fulfilled' ? stimoRaw.value : []).filter(item => item.inStock).map(item => { const priceEUR = item.yourPrice || 0; let delivery = item.deliveryDays || '-'; if (delivery && delivery !== '-') delivery = delivery.replace(/(\d+)/g, match => String(parseInt(match) + 2)); else delivery = '1 ден'; if (!delivery.includes('дни') && !delivery.includes('ден')) delivery += ' дни'; return { partNumber: item.partNumber, description: item.description || '', priceEUR, calculatedPrice: priceEUR, stock: 1, stockStatus: 'in_stock', brand: item.brand || '', deliveryDays: delivery, source: 'stimo', supplierName: 'Стимо' }; });
    const thunderResults = (thunderRaw.status === 'fulfilled' ? thunderRaw.value : []).map(item => ({ partNumber: item.partNumber, description: item.description || '', priceEUR: item.priceEUR || 0, calculatedPrice: item.calculatedPrice || 0, stock: item.stock || 1, stockStatus: item.stockStatus || 'in_stock', brand: item.brand || '', deliveryDays: item.deliveryDays || '15-20 дни', weight: item.weight || 0, source: 'thunder', supplierName: item.supplierName || 'Тандер', thunderOption: item.thunderOption || '' }));
    const allResults = [...impexResults, ...apecResults, ...emexResults, ...stimoResults, ...thunderResults];
    allResults.sort((a, b) => (a.calculatedPrice || 0) - (b.calculatedPrice || 0));
    const elapsed = Date.now() - startTime;
    res.json({ success: true, query: q, impexCount: impexResults.length, apecCount: apecResults.length, emexCount: emexResults.length, stimoCount: stimoResults.length, thunderCount: thunderResults.length, totalCount: allResults.length, elapsed, rates, results: allResults.slice(0, 60) });
  } catch (error) { res.status(500).json({ error: 'Search failed', message: error.message }); }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), twocaptchaKeySet: !!process.env.TWOCAPTCHA_KEY, twocaptchaKeyLen: (process.env.TWOCAPTCHA_KEY || '').trim().length, caches: { rates: !!cachedRates, apec: !!apecToken, emex: !!emexCid, stimo: !!stimoCookies, thunder: !!thunderCookies, autohelp: ahLoggedIn } });
});

// ============ ECONT ENDPOINTS ============
app.post('/api/econt/label', async (req, res) => {
  try { const { mode, shipment, credentials } = req.body; if (!credentials?.username || !credentials?.password) return res.status(400).json({ error: 'Econt credentials required' }); const baseUrl = credentials.env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(credentials.username + ':' + credentials.password).toString('base64'); const response = await fetch(baseUrl + '/Shipments/LabelService.createLabel.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ label: shipment, mode: mode || 'calculate' }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/offices', async (req, res) => {
  try { const { username, password, env } = req.body; const baseUrl = env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(username + ':' + password).toString('base64'); const response = await fetch(baseUrl + '/Nomenclatures/NomenclaturesService.getOffices.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ countryCode: 'BGR' }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/econt/offices', async (req, res) => {
  try { const { username, password, env } = req.query; const baseUrl = env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(username + ':' + password).toString('base64'); const response = await fetch(baseUrl + '/Nomenclatures/NomenclaturesService.getOffices.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ countryCode: 'BGR' }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/cities', async (req, res) => {
  try { const { username, password, env } = req.body; const baseUrl = env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(username + ':' + password).toString('base64'); const response = await fetch(baseUrl + '/Nomenclatures/NomenclaturesService.getCities.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ countryCode: 'BGR' }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/econt/cities', async (req, res) => {
  try { const { username, password, env } = req.query; const baseUrl = env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(username + ':' + password).toString('base64'); const response = await fetch(baseUrl + '/Nomenclatures/NomenclaturesService.getCities.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ countryCode: 'BGR' }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/track', async (req, res) => {
  try { const { shipmentNumbers, credentials } = req.body; const baseUrl = credentials.env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(credentials.username + ':' + credentials.password).toString('base64'); const response = await fetch(baseUrl + '/Shipments/ShipmentService.getShipmentStatuses.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ shipmentNumbers }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/delete-label', async (req, res) => {
  try { const { shipmentNumber, credentials } = req.body; const baseUrl = credentials.env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(credentials.username + ':' + credentials.password).toString('base64'); const response = await fetch(baseUrl + '/Shipments/LabelService.deleteLabels.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ shipmentNumbers: [shipmentNumber] }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/streets', async (req, res) => {
  try { const { username, password, env, cityName } = req.body; const baseUrl = env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(username + ':' + password).toString('base64'); const response = await fetch(baseUrl + '/Nomenclatures/NomenclaturesService.getStreets.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({ cityName }) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/econt/profiles', async (req, res) => {
  try { const { credentials } = req.body; if (!credentials?.username || !credentials?.password) return res.status(400).json({ error: 'Econt credentials required' }); const baseUrl = credentials.env === 'demo' ? 'https://demo.econt.com/ee/services' : 'https://ee.econt.com/services'; const auth = Buffer.from(credentials.username + ':' + credentials.password).toString('base64'); const response = await fetch(baseUrl + '/Profile/ProfileService.getClientProfiles.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }, body: JSON.stringify({}) }); res.json(await response.json()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ TEST ENDPOINTS ============
app.get('/api/test-autohelp', async (req, res) => {
  try {
    const r = await fetch('https://eshop.autohelp.bg/Eshop/Login.aspx', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    res.json({ ok: true, status: r.status, len: (await r.text()).length });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ============ START SERVER ============
app.listen(PORT, () => {
  console.log(`🚀 AutoFix API running on port ${PORT}`);
});
