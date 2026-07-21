/**
 * The page reader.
 *
 * Everything here is stringified and evaluated *inside* the Indeed page, so it must
 * be plain browser JS with no imports and no TypeScript at runtime.
 *
 * THIS IS THE FRAGILE FILE. Indeed can change its markup at any time, and when it
 * does, this is the only file that needs editing. Every selector is in SELECTORS
 * below, and extraction reports a health score so the UI can tell the user
 * "Indeed changed their layout" instead of silently showing an empty feed.
 */

export interface RawJob {
  id: string
  title: string
  company: string
  companyId: string | null
  /**
   * The company's Indeed star rating, 0–5. Null when they have none — plenty of
   * small employers don't, and an empty star row would be worse than no row.
   */
  companyRating: number | null
  location: string
  url: string
  salaryText: string | null
  postedRelative: string | null
  /** Real epoch ms, when the page's embedded JSON gave us one. Far better than "5 days ago". */
  postedEpoch: number | null
  snippet: string | null
  description: string | null
  remoteFlag: boolean
  /**
   * Indeed's own work-model verdict, e.g. `REMOTE_HYBRID`. Far more reliable than
   * reading the prose, and present on most listings. Null on the DOM fallback path.
   */
  remoteModel: string | null
  promoted: boolean
  urgentlyHiring: boolean
  applicantHint: number | null
  rank: number
}

export interface ExtractionResult {
  jobs: RawJob[]
  /** 0..1 — share of cards we read every essential field from. Drives the health banner. */
  health: number
  /** True when the page is a bot challenge rather than results. */
  challenged: boolean
  totalCards: number
  source: 'json' | 'dom' | 'none'
}

/**
 * Single source of truth for Indeed's markup. Update here when extraction breaks.
 */
export const SELECTORS = {
  card: '.job_seen_beacon, [data-testid="slider_item"], td.resultContent',
  cardKey: '[data-jk]',
  // Verified against live markup 2026-07-21: the title heading is now h3, not h2.
  // Both are listed so an Indeed rollback doesn't break extraction again.
  title:
    'h2.jobTitle span[title], h3.jobTitle span[title], h2.jobTitle a span, h3.jobTitle a span, [data-testid="jobTitle"]',
  titleLink: 'h2.jobTitle a, h3.jobTitle a, a.jcs-JobTitle',
  company: '[data-testid="company-name"], span.companyName, [data-testid="company-name"] a',
  location: '[data-testid="text-location"], div.companyLocation',
  salary:
    '[data-testid="attribute_snippet_testid"], .salary-snippet-container, .estimated-salary, .metadata.salary-snippet-container',
  date: '[data-testid="myJobsStateDate"], .date, span.date',
  snippet: '.job-snippet, [data-testid="jobsnippet_footer"], .underShelfFooter',
  urgent: '.urgentlyHiring, [aria-label*="Urgently hiring" i]',
  promoted: '.sponsoredJob, [data-testid="sponsored-badge"], span.sponsoredGray',
  challenge: '#challenge-running, .cf-browser-verification, [data-testid="captcha"], form#challenge-form'
} as const

/**
 * The extractor, as source text. Written as a template string so it can be handed
 * to `webContents.executeJavaScript`.
 *
 * Strategy: prefer Indeed's own embedded JSON model (it carries real `pubDate`
 * timestamps, which is what makes Date Reveal exact rather than a guess), and fall
 * back to reading the rendered DOM when that model isn't present.
 */
export function buildSearchExtractor(): string {
  return `(function () {
  var S = ${JSON.stringify(SELECTORS)};

  function text(node, sel) {
    var el = node.querySelector(sel);
    return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  }

  function isChallenged() {
    if (document.querySelector(S.challenge)) return true;
    var t = (document.title || '').toLowerCase();
    return t.indexOf('just a moment') >= 0 || t.indexOf('verify') >= 0 ||
           t.indexOf('security check') >= 0 || t.indexOf('access denied') >= 0;
  }

  // ---- preferred path: Indeed's embedded job-card model -------------------
  function fromEmbeddedJson() {
    var results = null;
    try {
      var pd = window.mosaic && window.mosaic.providerData;
      var model = pd && pd['mosaic-provider-jobcards'];
      var meta = model && (model.metaData || model);
      var m = meta && meta.mosaicProviderJobCardsModel;
      results = (m && m.results) || (meta && meta.results) || null;
    } catch (e) { results = null; }

    if (!results || !results.length) return null;

    return results.map(function (r, i) {
      // Indeed has shipped both pubDate and createDate over the years; take whichever exists.
      var epoch = r.pubDate || r.createDate || r.formattedRelativeTime_epoch || null;
      if (epoch && epoch < 1e12) epoch = epoch * 1000; // seconds → ms

      // salarySnippet.text is Indeed's own human wording ("£31,350 - £39,600 a
      // year") and keeps nuance the numeric range loses, so it wins.
      var salary = null;
      if (r.salarySnippet && r.salarySnippet.text) {
        salary = r.salarySnippet.text;
      } else if (r.extractedSalary && (r.extractedSalary.min || r.extractedSalary.max)) {
        var es = r.extractedSalary;
        var unit = es.type ? (' a ' + String(es.type).toLowerCase()) : '';
        salary = (es.min === es.max || !es.max)
          ? String(es.min) + unit
          : String(es.min) + ' - ' + String(es.max) + unit;
      } else if (r.estimatedSalary && r.estimatedSalary.formattedRange) {
        salary = 'Estimated ' + r.estimatedSalary.formattedRange;
      }

      // Indeed's explicit work model, e.g. { type: 'REMOTE_HYBRID', text: 'Hybrid work' }.
      var model = null;
      if (r.remoteWorkModel && r.remoteWorkModel.type) {
        model = String(r.remoteWorkModel.type);
      } else if (r.remoteWorkModel && r.remoteWorkModel.text) {
        model = String(r.remoteWorkModel.text);
      }

      // The "remote" taxonomy GROUP exists on hybrid jobs too, so the group label
      // proves nothing — the individual attribute labels inside it are what matter.
      var taxonomyRemote = false;
      (r.taxonomyAttributes || []).forEach(function (group) {
        if (!group || group.label !== 'remote') return;
        (group.attributes || []).forEach(function (attr) {
          if (attr && attr.label && /remote/i.test(attr.label) && !/hybrid/i.test(attr.label)) {
            taxonomyRemote = true;
          }
        });
      });

      // applyCount is -1 when Indeed simply doesn't know. Treating that as a real
      // figure dragged the popularity score negative.
      var applicants = null;
      if (typeof r.applyCount === 'number' && r.applyCount > 0) applicants = r.applyCount;

      return {
        id: r.jobkey || r.jk || ('idx-' + i),
        title: r.displayTitle || r.title || '',
        company: r.company || r.truncatedCompany || '',
        companyId: r.companyIdEncrypted || r.companyOverviewLink || null,
        // Indeed sends 0 for "no rating", which must not render as a 0-star company.
        companyRating:
          typeof r.companyRating === 'number' && r.companyRating > 0 ? r.companyRating : null,
        location: r.formattedLocation || r.jobLocationCity || '',
        url: 'https://' + location.host + '/viewjob?jk=' + (r.jobkey || r.jk || ''),
        salaryText: salary,
        postedRelative: r.formattedRelativeTime || null,
        postedEpoch: epoch || null,
        snippet: (r.snippet || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim(),
        description: null,
        remoteFlag: !!(r.remoteLocation || taxonomyRemote),
        remoteModel: model,
        promoted: !!(r.sponsored || r.isSponsoredJob),
        urgentlyHiring: !!(r.urgentlyHiring || r.indeedApplyable === 'urgent'),
        applicantHint: applicants,
        rank: i
      };
    });
  }

  // ---- fallback path: read the rendered cards -----------------------------
  function fromDom() {
    var cards = Array.prototype.slice.call(document.querySelectorAll(S.card));
    return cards.map(function (card, i) {
      var keyEl = card.matches(S.cardKey) ? card : card.querySelector(S.cardKey);
      var jk = keyEl ? keyEl.getAttribute('data-jk') : null;
      var link = card.querySelector(S.titleLink);
      var titleEl = card.querySelector(S.title);
      var title = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() : '';
      var loc = text(card, S.location) || '';
      var body = (card.textContent || '');

      // Rendered rating, for the fallback path: Indeed labels it "3.5 out of 5 stars".
      var ratingEl = card.querySelector('[aria-label*="out of 5 star" i], [data-testid="holistic-rating"]');
      var ratingText = ratingEl
        ? (ratingEl.getAttribute('aria-label') || ratingEl.textContent || '')
        : '';
      var ratingMatch = ratingText.match(/(\\d(?:\\.\\d)?)/);
      var rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      return {
        id: jk || ('dom-' + i),
        title: title.replace(/\\s+/g, ' '),
        company: text(card, S.company) || '',
        companyId: null,
        companyRating: rating && rating > 0 ? rating : null,
        location: loc,
        url: link && link.href ? link.href : ('https://' + location.host + '/viewjob?jk=' + (jk || '')),
        salaryText: text(card, S.salary),
        postedRelative: text(card, S.date),
        postedEpoch: null,
        snippet: text(card, S.snippet),
        description: null,
        remoteFlag: /\\bremote\\b/i.test(loc) || /\\bremote\\b/i.test(body),
        remoteModel: null,
        promoted: !!card.querySelector(S.promoted),
        urgentlyHiring: !!card.querySelector(S.urgent),
        applicantHint: null,
        rank: i
      };
    });
  }

  if (isChallenged()) {
    return { jobs: [], health: 0, challenged: true, totalCards: 0, source: 'none' };
  }

  var source = 'json';
  var jobs = fromEmbeddedJson();
  if (!jobs || !jobs.length) { jobs = fromDom(); source = 'dom'; }
  if (!jobs) jobs = [];

  // Keep only rows we can actually identify and act on.
  var usable = jobs.filter(function (j) { return j.id && j.title && j.company; });
  var health = jobs.length ? usable.length / jobs.length : 0;

  return {
    jobs: usable,
    health: health,
    challenged: false,
    totalCards: jobs.length,
    source: usable.length ? source : 'none'
  };
})()`
}

/**
 * Reads a single job's full description. Used when caching an applied listing and
 * when the work-mode classifier needs more than a snippet to judge a "remote" claim.
 */
export function buildDetailExtractor(): string {
  return `(function () {
  function grab(sel) {
    var el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').replace(/\\r/g, '').trim() : null;
  }

  if (document.querySelector('#challenge-running, form#challenge-form')) {
    return { challenged: true };
  }

  return {
    challenged: false,
    description:
      grab('#jobDescriptionText') ||
      grab('[data-testid="jobsearch-JobComponent-description"]') ||
      grab('.jobsearch-JobComponent-description'),
    title: grab('h1.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"]'),
    company: grab('[data-testid="inlineHeader-companyName"], [data-company-name="true"]'),
    location: grab('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]'),
    salaryText: grab('#salaryInfoAndJobType, [data-testid="jobsearch-OtherJobDetailsContainer"]')
  };
})()`
}

/**
 * Detects whether the current page shows a signed-in user. Indeed swaps the header
 * account control, which is the most stable tell across their layouts.
 */
export function buildAuthExtractor(): string {
  return `(function () {
  var el = document.querySelector('[data-gnav-element-name="AccountMenu"], #gnav-AccountMenu, [data-testid="gnav-AccountMenu"]');
  var signIn = document.querySelector('[data-gnav-element-name="SignIn"], a[href*="/account/login"]');
  var email = null;
  try {
    var m = document.body.innerHTML.match(/"email"\\s*:\\s*"([^"]+@[^"]+)"/);
    if (m) email = m[1];
  } catch (e) {}
  return { loggedIn: !!el && !signIn, email: email };
})()`
}
