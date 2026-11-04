/** Quantize AI — five-provider scholarly search server. Node.js 20+; no dependencies. */
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.key_X6uyihW7ZYBknI9L
});
const PROVIDERS = ['crossref', 'openalex', 'europepmc', 'openaire', 'semanticscholar', 'pubmed', 'arxiv', 'eric', 'doaj', 'clinicaltrials', 'hal'];
// Publisher discovery, not a direct/licensed partnership with the publishers.
const NEWS_PUBLISHERS = [
  {id:'reuters', name:'Reuters', domain:'reuters.com'},
  {id:'ap', name:'Associated Press', domain:'apnews.com'},
  {id:'bbc', name:'BBC News', domain:'bbc.com'},
  {id:'guardian', name:'The Guardian', domain:'theguardian.com'},
  {id:'nytimes', name:'The New York Times', domain:'nytimes.com'},
  {id:'washingtonpost', name:'The Washington Post', domain:'washingtonpost.com'},
  {id:'wsj', name:'The Wall Street Journal', domain:'wsj.com'},
  {id:'ft', name:'Financial Times', domain:'ft.com'},
  {id:'latimes', name:'Los Angeles Times', domain:'latimes.com'},
  {id:'bloomberg', name:'Bloomberg', domain:'bloomberg.com'}
];
const LABELS = {
  crossref: 'Crossref', openalex: 'OpenAlex', europepmc: 'Europe PMC',
  openaire: 'OpenAIRE (Europe)', semanticscholar: 'Semantic Scholar', pubmed: 'PubMed', arxiv: 'arXiv', eric: 'ERIC', doaj: 'DOAJ', clinicaltrials: 'ClinicalTrials.gov', hal: 'HAL Open Science'
};
const PORT = Number(process.env.PORT || 3000);
const LIMIT = 25; // Maximum records per provider before deduplication.
const TIMEOUT_MS = 20000;
const CACHE_MS = 120000;
const CACHE_MAX = 120;
const cache = new Map();

// Classifications are hints based on index metadata/title, NOT evidence of peer review.
function classifySecondary(title, type) {
  const name = clean(title).toLowerCase();
  const category = clean(type).toLowerCase();
  if (category.includes('book-review') || category.includes('peer-review')) return null;
  const combined = `${name} ${category}`;
  let label = '';
  if (/meta[ -]?analys(?:is|es)/i.test(combined)) label = 'Meta-analysis';
  else if (/systematic[ -]?review/i.test(combined)) label = 'Systematic review';
  else if (/scoping[ -]?review|umbrella[ -]?review/i.test(combined)) label = 'Evidence review';
  else if (/literature[ -]?review|review[ -]?article|research[ -]?synthesis|evidence[ -]?synthesis|literature[ -]?survey/i.test(combined)) label = 'Literature review';
  else if (/^(review|reviews)$/i.test(category) || /(?:^|[,; ])review(?:$|[,; ])/i.test(category)) label = 'Review article';
  else if (/\breview\b/i.test(name) && !/\bbook review\b/i.test(name)) label = 'Possible review';
  if (!label) return null;
  // Records tagged as review by an index have stronger evidence than title matches.
  const fromMetadata = /^(review|reviews)$/i.test(category) || /(?:^|[,; ])(?:review|metaanalysis|meta-analysis)(?:$|[,; ])/i.test(category);
  return {category:label, evidence:fromMetadata?'Publication-type metadata':'Title/description clue'};
}
const clean = value => String(value == null ? '' : value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
function normDoi(value) {
  let doi = clean(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  try { doi = decodeURIComponent(doi); } catch { /* keep original */ }
  return /^10\.\d{4,9}\//i.test(doi) ? doi.toLowerCase() : '';
}
function urlIfSafe(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function authorList(input) {
  if (typeof input === 'string') {
    return input.split(/\s*,\s*|\s+and\s+/i).slice(0, 12).map(name => ({ given:'', family:clean(name) })).filter(a => a.family);
  }
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map(a => {
    if (typeof a === 'string') return {given:'', family:clean(a)};
    const full = clean(a?.fullName || a?.fullname || a?.display_name || a?.name || a?.author?.name || '');
    return {given: clean(a?.given || a?.givenName || ''), family: clean(a?.family || a?.familyName || a?.surname || (full || ''))};
  }).filter(a => a.given || a.family);
}
function firstYear(...values) {
  for (const v of values) {
    const s = typeof v === 'object' && v !== null ? String(v.date || v.year || '') : String(v || '');
    const m = s.match(/(?:19|20)\d{2}/); if (m) return Number(m[0]);
  }
  return null;
}
function createRecord({title, doi, url, authors, year, journal, openAccess, oaUrl, provider, type}) {
  const validDoi = normDoi(doi), safeUrl = urlIfSafe(url);
  const name = clean(title);
  if (!name) return null;
  const secondary = classifySecondary(name, type);
  return {
    DOI: validDoi,
    URL: safeUrl || (validDoi ? `https://doi.org/${validDoi}` : ''),
    title: [name], author: authorList(authors),
    published: year ? {'date-parts': [[year]]} : null,
    'container-title': [clean(journal) || 'Publication record'],
    openAccess: Boolean(openAccess), oaUrl: urlIfSafe(oaUrl),
    provider, providers: [provider], sourceType: clean(type),
    secondaryCategory: secondary?.category || '', secondaryEvidence: secondary?.evidence || ''
  };
}
function parseCrossref(json) {
  return (json.message?.items || []).map(w => createRecord({
    title: w.title?.[0], doi: w.DOI, url: w.URL,
    authors: w.author || [], year: w.published?.['date-parts']?.[0]?.[0] || w.created?.['date-parts']?.[0]?.[0],
    journal: w['container-title']?.[0], openAccess: Boolean(w['license']?.some?.(l => /creativecommons|openaccess/i.test(l.URL || ''))),
    provider: 'crossref', type: w.type
  })).filter(Boolean);
}
function parseOpenAlex(json) {
  return (json.results || []).map(w => createRecord({
    title: w.display_name || w.title, doi: w.doi, url: w.primary_location?.landing_page_url || w.id,
    authors: (w.authorships || []).map(a => a.author?.display_name || '').filter(Boolean),
    year: w.publication_year, journal: w.primary_location?.source?.display_name,
    openAccess: w.open_access?.is_oa,
    oaUrl: w.best_oa_location?.pdf_url || w.best_oa_location?.landing_page_url || w.primary_location?.pdf_url,
    provider: 'openalex', type: w.type
  })).filter(Boolean);
}
function parseEuropePMC(json) {
  return (json.resultList?.result || []).map(w => {
    const articleUrl = w.doi ? `https://doi.org/${normDoi(w.doi)}` :
      w.source && w.id ? `https://europepmc.org/article/${encodeURIComponent(w.source)}/${encodeURIComponent(w.id)}` : '';
    return createRecord({
      title: w.title, doi: w.doi, url: articleUrl, authors: w.authorString,
      year: firstYear(w.firstPublicationDate, w.pubYear), journal: w.journalTitle,
      openAccess: w.isOpenAccess === 'Y' || w.isOpenAccess === true,
      oaUrl: w.fullTextUrlList?.fullTextUrl?.find?.(x => x.availability === 'Open access')?.url || (w.isOpenAccess === 'Y' && w.pmcid ? `https://europepmc.org/articles/${w.pmcid}` : ''),
      provider: 'europepmc', type: w.pubTypeList?.pubType?.join(', ') || w.pubType
    });
  }).filter(Boolean);
}
function firstDoiFromOpenAire(w) {
  const candidates = [w.doi, w.ids?.doi, w.pids?.doi, w.pid, w.ids];
  for (const c of candidates) {
    if (typeof c === 'string' && normDoi(c)) return normDoi(c);
    if (Array.isArray(c)) for (const p of c) {
      const id = typeof p === 'string' ? p : (p?.value || p?.id || p?.doi);
      if (normDoi(id)) return normDoi(id);
    }
    if (c && typeof c === 'object') {
      for (const v of Object.values(c)) {
        if (typeof v === 'string' && normDoi(v)) return normDoi(v);
        if (Array.isArray(v)) for (const item of v) if (normDoi(item?.value || item?.id || item)) return normDoi(item?.value || item?.id || item);
      }
    }
  }
  return '';
}
function parseOpenAIRE(json) {
  return (json.results || []).map(w => {
    const authors = w.authors || w.authorships?.map?.(x => x.author?.fullname || x.author?.fullName || x.author?.name || x.fullname).filter(Boolean) || w.author || w.creators || [];
    const journal = w.journal?.name || w.journal?.title || w.publisher || w.best_oa?.hosted_by?.name;
    const mainTitle = typeof w.mainTitle === 'object' ? (w.mainTitle?.value || w.mainTitle?.title) : w.mainTitle;
    const open = /open/i.test(String(w.best_oa?.rights || w.bestOpenAccessRightLabel || ''));
    return createRecord({
      title: mainTitle || w.title, doi: firstDoiFromOpenAire(w),
      url: w.best_oa?.url || w.best_oa?.landing_page_url || w.url || '',
      authors, year: firstYear(w.publicationDate, w.publicationYear), journal,
      openAccess: open, oaUrl: open ? (w.best_oa?.url || w.best_oa?.landing_page_url) : '',
      provider: 'openaire', type: w.type
    });
  }).filter(Boolean);
}
function parseSemanticScholar(json) {
  return (json.data || []).map(w => createRecord({
    title: w.title, doi: w.externalIds?.DOI, url: w.url, authors: w.authors || [],
    year: w.year, journal: w.venue || w.journal?.name,
    openAccess: w.isOpenAccess || Boolean(w.openAccessPdf?.url), oaUrl: w.openAccessPdf?.url,
    provider: 'semanticscholar', type: (w.publicationTypes || []).join(', ')
  })).filter(Boolean);
}
async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': 'QuantizeAIStudentResearch/1.0 (academic metadata search)', ...headers},
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const queryUrl = (root, entries) => {
  const u = new URL(root); for (const [key, value] of Object.entries(entries)) if (value != null && value !== '') u.searchParams.set(key, value);
  return u.href;
};

function parsePubMed(json) {
  const result = json.result || {};
  return (result.uids || []).map(id => {
    const w = result[id];
    if (!w) return null;

    const doi = (w.articleids || [])
      .find(x => x.idtype === 'doi')?.value || '';

    return createRecord({
      title: w.title,
      doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      authors: (w.authors || []).map(a => a.name),
      year: firstYear(w.pubdate, w.epubdate),
      journal: w.fulljournalname || w.source,
      openAccess: false,
      provider: 'pubmed',
      type: (w.pubtype || []).join(', ')
    });
  }).filter(Boolean);
}

async function searchPubMed(q, secondaryOnly = false) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';

  const term = secondaryOnly
    ? `(${q}) AND (review[pt] OR meta-analysis[pt])`
    : q;

  const searchUrl = queryUrl(base + 'esearch.fcgi', {
    db: 'pubmed',
    term,
    retmax: LIMIT,
    retmode: 'json'
  });

  const search = await fetchJson(searchUrl);
  const ids = search.esearchresult?.idlist || [];

  if (!ids.length) return [];

  const summaryUrl = queryUrl(base + 'esummary.fcgi', {
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json'
  });

  return parsePubMed(await fetchJson(summaryUrl));
}


function parseArxiv(xml) {
  const decode = s => String(s || '')
    .replace(/&#x([0-9a-f]+);/gi,
      (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g,
      (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  const tag = (xml, name) => {
    const match = xml.match(
      new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i')
    );
    return decode(match?.[1] || '').replace(/\s+/g, ' ').trim();
  };

  const entries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/g) || [];

  return entries.map(entry => {
    const title = tag(entry, 'title');
    const articleUrl = tag(entry, 'id');
    const published = tag(entry, 'published');
    const doi = tag(entry, 'arxiv:doi');

    const authors = [...entry.matchAll(
      /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g
    )].map(match => tag(match[1], 'name'));

    if (!title || !articleUrl ||
        articleUrl.includes('/api/errors')) return null;

    return createRecord({
      title,
      doi,
      url: articleUrl,
      authors,
      year: firstYear(published),
      journal: 'arXiv',
      openAccess: true,
      oaUrl: articleUrl,
      provider: 'arxiv',
      type: 'preprint'
    });
  }).filter(Boolean);
}

async function searchArxiv(q, secondaryOnly = false) {
  const url = new URL('https://export.arxiv.org/api/query');

  const safeQuery = q.replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();

  url.searchParams.set('search_query', 'all:' + safeQuery);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(LIMIT));

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'QuantizeAIStudentResearch/1.0'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) throw new Error('arXiv HTTP ' + response.status);

  const records = parseArxiv(await response.text());

  return secondaryOnly
    ? records.filter(r => r.secondaryCategory)
    : records;
}


async function searchEric(q, secondaryOnly = false) {
  const url = queryUrl('https://api.ies.ed.gov/eric/', {
    search: q,
    format: 'json',
    rows: LIMIT
  });

  const data = await fetchJson(url);
  const docs = data.response?.docs || [];

  return docs.filter(w => {
    if (!secondaryOnly) return true;
    const types = [].concat(w.publicationtype || [])
      .join(' ').toLowerCase();
    return /review|meta-analysis|research synthesis|information analyses/.test(types);
  }).map(w => createRecord({
    title: w.title || '',
    doi: '',
    url: 'https://eric.ed.gov/?id=' + encodeURIComponent(w.id),
    authors: [].concat(w.author || []),
    year: firstYear(w.publicationdateyear, w.publicationdate),
    journal: w.source || 'ERIC',
    openAccess: false,
    provider: 'eric',
    type: [].concat(w.publicationtype || []).join(', ')
  })).filter(w => w.title?.[0]);
}


async function searchDoaj(q, secondaryOnly = false) {
  const base = 'https://doaj.org/api/v4/search/articles/';
  const url = queryUrl(base + encodeURIComponent(q), {
    page: 1,
    pageSize: LIMIT
  });

  const data = await fetchJson(url);
  const articles = data.results || [];

  return articles.filter(item => {
    if (!secondaryOnly) return true;
    const b = item.bibjson || {};
    return /\\b(review|systematic review|meta-analysis)\\b/i
      .test((b.title || '') + ' ' + (b.abstract || ''));
  }).map(item => {
    const b = item.bibjson || {};
    const identifiers = b.identifier || [];
    const doi = identifiers.find(i =>
      i.type?.toLowerCase() === 'doi'
    )?.id || '';

    const links = b.link || [];
    const articleUrl = links.find(l =>
      l.type === 'fulltext'
    )?.url || links[0]?.url ||
      (doi ? 'https://doi.org/' + doi : '');

    return createRecord({
      title: b.title || '',
      doi,
      url: articleUrl,
      authors: (b.author || []).map(a => a.name),
      year: firstYear(b.year),
      journal: b.journal?.title || 'DOAJ',
      openAccess: true,
      oaUrl: articleUrl,
      provider: 'doaj',
      type: 'journal-article'
    });
  }).filter(w => w.title?.[0]);
}


async function searchClinicalTrials(q, secondaryOnly = false) {
  // Registrations are primary research records, not reviews.
  if (secondaryOnly) return [];

  const url = queryUrl('https://clinicaltrials.gov/api/v2/studies', {
    'query.term': q,
    pageSize: LIMIT,
    format: 'json'
  });

  const data = await fetchJson(url);

  return (data.studies || []).map(study => {
    const p = study.protocolSection || {};
    const id = p.identificationModule || {};
    const status = p.statusModule || {};
    const sponsor = p.sponsorCollaboratorsModule || {};
    const nctId = id.nctId;

    if (!nctId || !id.briefTitle) return null;

    return createRecord({
      title: id.briefTitle,
      doi: '',
      url: 'https://clinicaltrials.gov/study/' + nctId,
      authors: sponsor.leadSponsor?.name
        ? [sponsor.leadSponsor.name]
        : [],
      year: firstYear(
        status.studyFirstSubmitDate,
        status.startDateStruct?.date
      ),
      journal: 'ClinicalTrials.gov',
      openAccess: false,
      provider: 'clinicaltrials',
      type: 'Clinical trial registration'
    });
  }).filter(Boolean);
}


async function searchHal(q, secondaryOnly = false) {
  const url = queryUrl('https://api.archives-ouvertes.fr/search/', {
    q,
    rows: LIMIT,
    wt: 'json',
    fl: 'title_s,halId_s,uri_s,producedDateY_i,authFullName_s,doiId_s,journalTitle_s,docType_s,files_s'
  });

  const data = await fetchJson(url);
  const docs = data.response?.docs || [];

  return docs.filter(doc => {
    if (!secondaryOnly) return true;
    const title = [].concat(doc.title_s || []).join(' ');
    const type = [].concat(doc.docType_s || []).join(' ');
    return /review|meta-analysis|systematic review/i.test(title + ' ' + type);
  }).map(doc => {
    const first = value =>
      Array.isArray(value) ? (value[0] || '') : (value || '');

    const title = first(doc.title_s);
    const doi = first(doc.doiId_s);
    const url = first(doc.uri_s) ||
      (doc.halId_s ? 'https://hal.science/' + doc.halId_s : '');

    const files = [].concat(doc.files_s || []).filter(Boolean);

    return createRecord({
      title,
      doi,
      url,
      authors: [].concat(doc.authFullName_s || []),
      year: firstYear(doc.producedDateY_i),
      journal: first(doc.journalTitle_s) || 'HAL Open Science',
      openAccess: files.length > 0,
      oaUrl: files.length > 0 ? url : '',
      provider: 'hal',
      type: first(doc.docType_s) || 'Research repository record'
    });
  }).filter(record => record.title?.[0]);
}

const SEARCHERS = {
  async hal(q, secondaryOnly = false) {
    return searchHal(q, secondaryOnly);
  },
  async clinicaltrials(q, secondaryOnly = false) {
    return searchClinicalTrials(q, secondaryOnly);
  },
  async doaj(q, secondaryOnly = false) {
    return searchDoaj(q, secondaryOnly);
  },
  async eric(q, secondaryOnly = false) {
    return searchEric(q, secondaryOnly);
  },
  async arxiv(q, secondaryOnly = false) {
    return searchArxiv(q, secondaryOnly);
  },
  async pubmed(q, secondaryOnly = false) {
    return searchPubMed(q, secondaryOnly);
  },
  async crossref(q, secondaryOnly = false) {
    const url = queryUrl('https://api.crossref.org/works', {'query.bibliographic':secondaryOnly ? `${q} systematic review` : q, rows:LIMIT});
    return parseCrossref(await fetchJson(url));
  },
  async openalex(q, secondaryOnly = false) {
    const url = queryUrl('https://api.openalex.org/works', {search:q, filter:secondaryOnly ? 'type:review' : '', per_page:LIMIT, api_key:process.env.OPENALEX_API_KEY || ''});
    return parseOpenAlex(await fetchJson(url));
  },
  async europepmc(q, secondaryOnly = false) {
    const url = queryUrl('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {query:secondaryOnly?`(${q}) AND PUB_TYPE:review`:q, format:'json', resultType:'core', pageSize:LIMIT});
    return parseEuropePMC(await fetchJson(url));
  },
  async openaire(q, secondaryOnly = false) {
    const url = queryUrl('https://api.openaire.eu/graph/v4/research-products', {search:secondaryOnly ? `${q} review` : q, filter:'type:publication', page_size:LIMIT, mailto:process.env.CONTACT_EMAIL || ''});
    return parseOpenAIRE(await fetchJson(url));
  },
  async semanticscholar(q, secondaryOnly = false) {
    const url = queryUrl('https://api.semanticscholar.org/graph/v1/paper/search', {
      query:q, limit:LIMIT, publicationTypes:secondaryOnly?'Review,MetaAnalysis':'', fields:'title,year,authors,url,venue,externalIds,isOpenAccess,openAccessPdf,publicationTypes'
    });
    const headers = process.env.SEMANTIC_SCHOLAR_API_KEY ? {'x-api-key':process.env.SEMANTIC_SCHOLAR_API_KEY} : {};
    return parseSemanticScholar(await fetchJson(url, headers));
  }
};
function recordKey(w) {
  if (w.DOI) return `doi:${w.DOI.toLowerCase()}`;
  const normalizedTitle = w.title[0].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `title:${normalizedTitle}:${w.published?.['date-parts']?.[0]?.[0] || ''}`;
}
function merge(results, yearStart = null) {
  const seen = new Map();
  // Interleave providers rather than letting the first database dominate the results.
  const longest = Math.max(0, ...results.map(x => x.records.length));
  for (let i = 0; i < longest; i++) for (const group of results) {
    const w = group.records[i]; if (!w) continue;
    const yr = w.published?.['date-parts']?.[0]?.[0];
    if (yearStart && (!yr || yr < yearStart)) continue;
    const k = recordKey(w), previous = seen.get(k);
    if (previous) {
      previous.providers = [...new Set([...previous.providers, ...w.providers])];
      previous.openAccess ||= w.openAccess;
      previous.oaUrl ||= w.oaUrl;
      previous.DOI ||= w.DOI; previous.URL ||= w.URL;
      if (w.secondaryEvidence === 'Publication-type metadata' && previous.secondaryEvidence !== 'Publication-type metadata') {
        previous.secondaryCategory = w.secondaryCategory; previous.secondaryEvidence = w.secondaryEvidence;
      } else if (!previous.secondaryCategory && w.secondaryCategory) {
        previous.secondaryCategory = w.secondaryCategory; previous.secondaryEvidence = w.secondaryEvidence;
      }
      if (!previous.author.length && w.author.length) previous.author = w.author;
    } else seen.set(k, {...w});
  }
  return [...seen.values()].slice(0, 125);
}
async function combinedSearch(q, providerIds, fromYear, secondaryOnly = false) {
  const key = JSON.stringify([q.toLowerCase(), providerIds, fromYear, secondaryOnly]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return {...cached.data, cached:true};
  const settled = await Promise.all(providerIds.map(async p => {
    try {
      const records = await SEARCHERS[p](q, secondaryOnly);
      return {provider:p, records:secondaryOnly ? records.filter(w=>w.secondaryCategory) : records, ok:true};
    }
    catch (e) { return {provider:p, records:[], ok:false, message: String(e.message || 'Unavailable').slice(0, 85)}; }
  }));
  const sources = settled.map(s => ({id:s.provider, label:LABELS[s.provider], status:s.ok ? 'ok' : 'unavailable', count:s.records.length, ...(s.ok ? {} : {message:s.message})}));
  const data = {query:q, secondaryOnly, results:merge(settled, fromYear), sources, totalBeforeDedup: settled.reduce((n,s) => n+s.records.length, 0), cached:false};
  // Don't cache an all-provider outage so the next attempt can retry immediately.
  if (settled.some(s => s.ok)) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, {data, expires:Date.now()+CACHE_MS});
  }
  return data;
}
function cleanNewsQuery(value) {
  // GDELT supports operators in its query language; prevent user-supplied operators.
  return clean(value).replace(/[():"\[\]{}]/g, ' ').replace(/\b(?:OR|AND|NOT|domain|domainis|sourcecountry|sourcelang)\b/gi,' ').replace(/\s+/g,' ').trim().slice(0,150);
}
function newsQuery(q, publisherId = 'all') {
  const safe = cleanNewsQuery(q);
  const list = publisherId === 'all' ? NEWS_PUBLISHERS : NEWS_PUBLISHERS.filter(p=>p.id===publisherId);
  return safe + ' (' + list.map(p => `domainis:${p.domain}`).join(' OR ') + ')';
}
function parseGdelt(json) {
  const domainMap = new Map(NEWS_PUBLISHERS.map(p => [p.domain,p]));
  const seen = new Set();
  return (json.articles || []).map(article => {
    const url = urlIfSafe(article.url);
    const domain = clean(article.domain).toLowerCase().replace(/^www\./,'');
    const outlet = domainMap.get(domain);
    if (!url || !outlet || seen.has(url)) return null;
    seen.add(url);
    const seenDate = clean(article.seendate);
    return {
      kind:'news', title:[clean(article.title) || 'Untitled article'],
      URL:url, DOI:'', author:[], 'container-title':[outlet.name],
      published:null, indexedDate: /^\d{14}$/.test(seenDate) ?
        `${seenDate.slice(0,4)}-${seenDate.slice(4,6)}-${seenDate.slice(6,8)}` : '',
      publisherId:outlet.id, provider:'gdelt', providers:['GDELT'], sourceType:'news'
    };
  }).filter(Boolean);
}

const GDELT_COOLDOWN_MS = 60000;
let gdeltBlockedUntil = 0;

async function gdeltNewsSearch(q,publisherId) {
  const key = JSON.stringify(['news-v2',q.toLowerCase(),publisherId]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return {...cached.data,cached:true};
if (Date.now() < gdeltBlockedUntil) {
  const seconds = Math.ceil((gdeltBlockedUntil - Date.now()) / 1000);
  throw new Error(`GDELT rate limited. Retry in ${seconds} seconds.`);
}

  // Keep the first attempt small and simple: the GDELT DOC API can reject
  // long OR expressions or throttle large result sets.
  const publisher = NEWS_PUBLISHERS.find(p => p.id === publisherId);
  const safe = cleanNewsQuery(q);
  const queries = publisher
    ? [`${safe} domainis:${publisher.domain}`, safe]
    : [safe];
  let lastError;
  for (const expression of queries) {
    const endpoint = queryUrl('https://api.gdeltproject.org/api/v2/doc/doc', {
      query: expression, mode:'artlist', format:'json', maxrecords:75
    });
    try {
      const json = await fetchJson(endpoint);
      const results = parseGdelt(json).filter(r => !publisher || r.publisherId === publisherId);
      const data = {query:q, results, publisher:publisherId, status:'ok',cached:false,
        note:'Results include articles indexed by GDELT from supported publishers. GDELT may not index every article.'};
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key,{data,expires:Date.now()+CACHE_MS});
      return data;
    } catch (error) {
      lastError = error;
      console.error('[Quantize AI news] GDELT request failed:', String(error.message || error));

      if (String(error.message || error).includes('429')) {
        gdeltBlockedUntil = Date.now() + GDELT_COOLDOWN_MS;
        console.log('[Quantize AI] GDELT rate limit reached. Cooling down for 60 seconds.');
        break;
      }
    }
  }
  throw lastError || new Error('News provider unavailable');
}


const GoogleNewsParser = require('rss-parser');
const googleNewsParser = new GoogleNewsParser({
  timeout: 12000
});

async function googleNewsSearch(q, publisherId) {
  const publisher = NEWS_PUBLISHERS.find(
    p => p.id === publisherId
  );

  const topic = cleanNewsQuery(q);
  const search = publisher
    ? `${topic} site:${publisher.domain}`
    : topic;

  const feedUrl = new URL(
    'https://news.google.com/rss/search'
  );

  feedUrl.searchParams.set('q', search);
  feedUrl.searchParams.set('hl', 'en-US');
  feedUrl.searchParams.set('gl', 'US');
  feedUrl.searchParams.set('ceid', 'US:en');

  const feed = await googleNewsParser.parseURL(
    feedUrl.toString()
  );

  const results = (feed.items || []).slice(0, 100)
    .map(item => {
      const link = urlIfSafe(item.link);
      if (!link) return null;

      const date = item.isoDate || item.pubDate;
      const parsedDate = date ? new Date(date) : null;

      return {
        kind: 'news',
        title: [item.title || 'Untitled article'],
        URL: link,
        DOI: '',
        author: [],
        'container-title': [
          publisher ? publisher.name : 'Google News'
        ],
        published: null,
        indexedDate: parsedDate &&
          !Number.isNaN(parsedDate.getTime())
            ? parsedDate.toISOString().slice(0, 10)
            : '',
        publisherId: publisher ? publisher.id : 'all',
        provider: 'google-news',
        providers: ['Google News'],
        sourceType: 'news'
      };
    })
    .filter(Boolean);

  return {
    query: q,
    results,
    publisher: publisherId,
    status: 'ok',
    cached: false,
    note: 'Google News RSS backup results. Publisher-specific searches are approximate.'
  };
}

async function newsSearch(q, publisherId) {
  try {
    if (Date.now() < gdeltBlockedUntil) {
      return await googleNewsSearch(q, publisherId);
    }

    const gdeltResult = await gdeltNewsSearch(q, publisherId);
    if (gdeltResult.results?.length > 0) {
      return gdeltResult;
    }
    console.log('[Quantize AI] GDELT returned no articles; using Google News.');
    return await googleNewsSearch(q, publisherId);
  } catch (error) {
    console.warn(
      '[Quantize AI] Using Google News backup:',
      error.message
    );

    return await googleNewsSearch(q, publisherId);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Access-Control-Allow-Origin':process.env.ALLOWED_ORIGIN || '*'});
  res.end(JSON.stringify(data));
}
async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res,400,{error:'Invalid request'}); }
if (req.method === 'POST' && url.pathname === '/api/chat') {
  try {
    let body = '';

    for await (const chunk of req) {
      body += chunk.toString();

      if (body.length > 16000) {
        return sendJson(res, 413, {
          error: 'Message too large'
        });
      }
    }

    const { message } = JSON.parse(body);

    if (
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 4000
    ) {
      return sendJson(res, 400, {
        error: 'Please enter a valid message.'
      });
    }

    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      instructions: `You are Quantize AI Research Coach.
Help high school and college students research topics,
evaluate credible primary and secondary sources,
and understand citations.
Never invent sources or citations.`,
      input: message
    });

    return sendJson(res, 200, {
      reply: response.output_text
    });

  } catch (error) {
    console.error('Chat request failed:', error.message);

    return sendJson(res, 500, {
      error: 'Unable to get an AI response.'
    });
  }
}  
if (req.method !== 'GET') return sendJson(res,405,{error:'Only GET requests are supported'});
  if (url.pathname === '/api/health') return sendJson(res,200,{ok:true,providers:PROVIDERS,news:'GDELT',publishers:NEWS_PUBLISHERS.length});
  if (url.pathname === '/api/publishers') return sendJson(res,200,{publishers:NEWS_PUBLISHERS});
  if (url.pathname === '/api/news') {
    const q = clean(url.searchParams.get('q') || '');
    const publisher = url.searchParams.get('publisher') || 'all';
    if (q.length < 2 || q.length > 150) return sendJson(res,400,{error:'Enter a news topic of 2 to 150 characters.'});
    if (publisher !== 'all' && !NEWS_PUBLISHERS.some(p=>p.id===publisher)) return sendJson(res,400,{error:'Unknown publisher.'});
 try {
  return sendJson(res, 200, await newsSearch(q, publisher));
} catch (error) {
  console.error('Quantize AI News Error:', error);
  return sendJson(res, 503, {
    error: 'News index temporarily unavailable.',
    results: []
  });
}
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2 || q.length > 180) return sendJson(res,400,{error:'Use a research topic between 2 and 180 characters.'});
    const raw = url.searchParams.get('providers');
    const ids = raw === null ? [...PROVIDERS] : [...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))];
    if (!ids.length || ids.some(p => !PROVIDERS.includes(p))) return sendJson(res,400,{error:'Select at least one valid database.'});
    const fromText = url.searchParams.get('fromYear');
    const fromYear = fromText ? Number(fromText) : null;
    if (fromText && (!Number.isInteger(fromYear) || fromYear < 1900 || fromYear > 2100)) return sendJson(res,400,{error:'Invalid starting year.'});
    const type = url.searchParams.get('type') || 'all';
    if (!['all','secondary'].includes(type)) return sendJson(res,400,{error:'Unknown source type.'});
    try { return sendJson(res,200,await combinedSearch(q,ids,fromYear,type==='secondary')); }
    catch { return sendJson(res,500,{error:'Unexpected search error.'}); }
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') return sendJson(res,404,{error:'Not found'});
  try {
    const page = await fs.readFile(path.join(__dirname,'index.html'));
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store'});
    res.end(page);
  } catch { sendJson(res,500,{error:'Unable to load website'}); }
}
if (require.main === module) {
  const server = http.createServer((req, res) => void handle(req,res));
  server.listen(PORT, '0.0.0.0', () => console.log(`Quantize AI running on port ${PORT}`));
}
module.exports = {handle, merge, recordKey, classifySecondary, parseCrossref, parseOpenAlex, parseEuropePMC, parseOpenAIRE, parseSemanticScholar, createRecord, combinedSearch, parseGdelt, newsSearch, newsQuery, NEWS_PUBLISHERS};
