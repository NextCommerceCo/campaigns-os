/**
 * <promo-banner> — Seasonal sale banner web component
 *
 * Automatically displays the active sale based on the current date.
 * Falls back to a generic promo banner when no sale is running.
 *
 * ─── BASIC USAGE ────────────────────────────────────────────────────────────
 *
 * Drop the element wherever the banner should appear:
 *
 *   <promo-banner></promo-banner>
 *
 * ─── CONTROLLING FROM FRONTMATTER ───────────────────────────────────────────
 *
 * Add these fields to the page's YAML frontmatter, then wire them into the
 * element using Liquid in the HTML:
 *
 *   ---
 *   promo_sale: "blackfriday"   ← force a specific sale by name (see list below)
 *   promo_topbar: "false"       ← "true" | "false" — override top bar visibility
 *   ---
 *
 *   <promo-banner
 *     {% if promo_sale %}force-sale="{{ promo_sale }}"{% endif %}
 *     {% if promo_topbar %}show-topbar="{{ promo_topbar }}"{% endif %}
 *   ></promo-banner>
 *
 * Omit either frontmatter field to let the component decide automatically.
 *
 * ─── HTML ATTRIBUTES ────────────────────────────────────────────────────────
 *
 *   force-sale="blackfriday"   Force a named sale regardless of the current date.
 *                              Useful for previewing future/past sales or locking a
 *                              campaign to a specific promo year-round.
 *
 *   force-sale="default"       Force the generic non-seasonal banner, ignoring any
 *                              active sale. Any unrecognised name also falls back here.
 *
 *   show-topbar="true"         Show the top bar even when it would normally be
 *   show-topbar="false"        hidden (e.g. on the generic banner), or hide it
 *                              on a sale that normally shows it.
 *
 * ─── URL PARAMS (preview overrides) ──────────────────────────────────────────────
 *
 *   ?sale=blackfriday          Same as force-sale attribute — useful for previews
 *   ?sale=default              Force the generic banner via URL
 *   ?topbar=on                 Show the top bar via URL
 *   ?banner=n                  Hide the entire banner section (SDK-level,
 *                              set on the wrapper div, not this component)
 *
 *   URL params always take priority over attributes for easy previews.
 *
 * ─── SALE NAMES (for force-sale  / ?sale=) ───────────────────────────────────
 *
 *   newyear · valentinesday · stpatricks · easter · mothersday · memorialday
 *   fathersday · 4thofjuly · summersale · backtoschool · halloween
 *   veteransday · blackfriday · cybermonday · xmas · yearend · newyear2027
 *
 * ─── ADDING OR EDITING A SALE ───────────────────────────────────────────────
 *
 * Each entry in the `sales` array below has this shape:
 *
 *   {
 *     name: "summersale",               ← unique ID used in force-sale / ?sale=
 *     start: new Date(2026, 5, 15),     ← month is 0-indexed (0 = Jan, 5 = Jun)
 *     end:   new Date(2026, 7, 31, 23, 59, 59),
 *     title: "SUMMER SALE!",            ← shown in top bar
 *     emoji: "☀️",                      ← shown either side of title
 *     offer1: "GET 1x FOR 63% OFF",     ← highlighted text in top bar
 *     offer2: "3x FOR 69% OFF",         ← second highlighted offer
 *     promoCode: "SUMMER26",            ← code shown in the bottom bar pill
 *     topBarBg: "#000000",              ← top bar background colour
 *     highlightColor: "#ACF4A1",        ← colour of offer1/offer2 text
 *     bannerText: "WITH CODE:",         ← label before the promo code pill
 *     bannerTextSec: "ORDER YOURS NOW", ← main bottom bar message
 *     limitedTime: "LIMITED TIME",      ← suffix shown after the code pill
 *   }
 *
 * To add a new sale: copy an existing entry, update all fields, and place it
 * in chronological order within the array.
 *
 * ────────────────────────────────────────────────────────────────────────────
 */
class PromoBanner extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.timerInterval = null;
  }

  connectedCallback() {
    const saleConfig = this.getCurrentSale();

    this.style.display = 'block';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: inherit;
        }

        .banner {
          text-align: center;
          color: white;
        }

        .top-bar {
          background-color: ${saleConfig.topBarBg || "#000000"};
          padding: 15px 0;
          display: ${saleConfig.showTopBar ? "block" : "none"};
        }

        .top-bar p {
          margin: 0;
          font-size: 17px;
          font-weight: bold;
        }

        .bottom-bar {
          background-color: var(--brand--color--primary,rgb(0, 0, 0));
          padding: 8px;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-wrap: nowrap;
          gap: 0;
        }

        .text {
          color: white;
          font-size: 17px;
          font-weight: bold;
          margin: 0;
          white-space: nowrap;
          display: ${saleConfig.showTopBar ? "flex" : "flex"};
          align-items: center;
        }

        .code {
          display: ${saleConfig.showTopBar ? "flex" : "inline-block"};
          justify-content:center;
          align-items:center;
          background-color: #ffffff30;
          color: white;
          font-size: 18px;
          padding: 5px 12px;
          font-weight: bold;
          border-radius: 8px;
          margin: 0 8px;
          white-space: nowrap;
        }

        .highlight {
          color: ${saleConfig.highlightColor || "#ACF4A1"};
        }

        .text-normal {
          font-weight: 400;
          margin-left: 4px;
        }

        .timer {
          display: ${saleConfig.showTimer ? "flex" : "none"};
          justify-content: center;
          align-items: center;
          gap: 13px;
          margin-left: 10px;
        }

        .timer-item {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }

        .timer-box {
          background-color: black;
          color: white;
          font-size: 16px;
          font-weight: bold;
          border-radius: 8px;
          width: 32px;
          height: 30px;
          display: flex;
          justify-content: center;
          align-items: center;
          box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
        }

        .timer-label {
          font-size: 12px;
          color: black;
          font-weight: 700;
          line-height: 20px;
        }

        .mobile-break {
          display: none;
        }

        .content-row {
          display: flex;
          align-items: center;
          gap: 0;
        }

        /* Mobile styles */
        @media (max-width: 991px) {
        .hide-mob{
          display: none;
        }

        .top-bar {
          padding: 6px 0;
        }
          .top-bar p {
            font-size: 15px;
            line-height: 20px;
          }

          .bottom-bar {
            flex-direction: column;
            padding: 5px 10px;
            gap: 8px;
          }

          .text {
            white-space: normal;
            text-align: center;
            display: ${saleConfig.showTopBar ? "flex" : "block"};
            align-items: center;
            flex-wrap: wrap;
            justify-content: center;
            font-size: 15px;
          }

          .code {
            font-size: 16px;
            margin: 0 5px;
          }

          .mobile-break {
            display: ${saleConfig.showTopBar ? "inline" : "block"};
          }

          .mobile-hide {
            display: none;
          }

          .content-row {
            justify-content: center;
          }
        }

        @media (max-width: 420px) {
          .text {
            font-size: 15px;
          }

          .code {
            font-size: 15px;
            margin: 0 5px;
          }
        }

        @media (max-width: 392px) {
          .text {
            font-size: 13px;
          }

          .code {
            font-size: 13px;
            margin: 0 5px;
          }
        }
      </style>

      <div class="banner">
        <div class="top-bar">
          <p>
            ${saleConfig.emoji} ${saleConfig.title} ${saleConfig.emoji}<span class="mobile-break"><br></span>
            <span class="highlight">${saleConfig.offer1}</span> or
            <span class="highlight">${saleConfig.offer2}</span>
          </p>
        </div>
        <div class="bottom-bar">
          <p class="text">
            <span>${saleConfig.bannerTextSec}</span> <span class="text-normal">${saleConfig.bannerText}</span><span class="code">${saleConfig.promoCode}</span>
            <span class="${saleConfig.showTopBar ? "hide-mob" : ""}">${saleConfig.limitedTime}</span>
          </p>

          <div class="content-row">
            <div class="timer">
              <div class="timer-item">
                <div class="timer-box" id="days">00</div>
                <div class="timer-label">DAYS</div>
              </div>
              <div class="timer-item">
                <div class="timer-box" id="hours">00</div>
                <div class="timer-label">HRS</div>
              </div>
              <div class="timer-item">
                <div class="timer-box" id="minutes">00</div>
                <div class="timer-label">MINS</div>
              </div>
              <div class="timer-item">
                <div class="timer-box" id="seconds">00</div>
                <div class="timer-label">SECS</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    if (saleConfig.showTimer && saleConfig.endDate) {
      this.startTimer(saleConfig.endDate);
    }
  }

  getCurrentSale() {
    const now = new Date();

    // URL param takes priority, then attribute preview override
    const urlParams = new URLSearchParams(window.location.search);
    const forceSale = urlParams.get('sale') || this.getAttribute('force-sale');

    // showTopBar override: explicit attribute > URL param > null (let each path decide)
    const hasTopBarOverride = this.hasAttribute('show-topbar') || urlParams.get('topbar') !== null;
    const topBarOverride = this.hasAttribute('show-topbar')
      ? this.getAttribute('show-topbar') !== 'false'
      : urlParams.get('topbar') === 'on';

    const applyTopBar = (defaultValue) => hasTopBarOverride ? topBarOverride : defaultValue;

    // ─── Sale schedule ───────────────────────────────────────────────────────
    // Add, remove, or edit entries here. Dates are checked in order — the first
    // matching sale wins. Months are 0-indexed: 0=Jan, 1=Feb … 11=Dec.
    const sales = [
      {
        name: "newyear",
        start: new Date(2025, 11, 26),
        end: new Date(2026, 0, 14, 23, 59, 59),
        title: "NEW YEAR SALE!",
        emoji: "🎆",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "NEWYEAR26",
        topBarBg: '#000000',
        highlightColor: '#ACF4A1',
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "valentinesday",
        start: new Date(2026, 1, 6),
        end: new Date(2026, 1, 15, 23, 59, 59),
        title: "VALENTINE'S DAY SALE!",
        emoji: "❤️",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "LOVE26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "stpatricks",
        start: new Date(2026, 2, 9),
        end: new Date(2026, 2, 22, 23, 59, 59),
        title: "ST. PATRICK'S DAY SALE!",
        emoji: "🍀",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "LUCKY26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "easter",
        start: new Date(2026, 2, 30),
        end: new Date(2026, 3, 12, 23, 59, 59),
        title: "EASTER SALE!",
        emoji: "🐣",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "EASTER26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "mothersday",
        start: new Date(2026, 3, 15),
        end: new Date(2026, 4, 17, 23, 59, 59),
        title: "MOTHER'S DAY SALE!",
        emoji: "🌸",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "MOM26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "memorialday",
        start: new Date(2026, 4, 22),
        end: new Date(2026, 4, 31, 23, 59, 59),
        title: "MEMORIAL DAY SALE!",
        emoji: "🇺🇸",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "MEMORIAL26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "fathersday",
        start: new Date(2026, 5, 15),
        end: new Date(2026, 5, 22, 23, 59, 59),
        title: "FATHER'S DAY SALE!",
        emoji: "👔",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "DAD26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "4thofjuly",
        start: new Date(2026, 5, 22),
        end: new Date(2026, 6, 5, 23, 59, 59),
        title: "4TH OF JULY SALE!",
        emoji: "🦅",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "FREEDOM26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "summersale",
        start: new Date(2026, 6, 15),
        end: new Date(2026, 7, 30, 23, 59, 59),
        title: "SUMMER SALE!",
        emoji: "☀️",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "SUMMER26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "backtoschool",
        start: new Date(2026, 7, 31),
        end: new Date(2026, 8, 13, 23, 59, 59),
        title: "BACK TO SCHOOL SALE!",
        emoji: "🏫",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "SCHOOL26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "halloween",
        start: new Date(2026, 9, 26),
        end: new Date(2026, 10, 1, 23, 59, 59),
        title: "HALLOWEEN SALE!",
        emoji: "🎃",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "SPOOKY26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "veteransday",
        start: new Date(2026, 10, 6),
        end: new Date(2026, 10, 10, 23, 59, 59),
        title: "VETERANS DAY SALE!",
        emoji: "🦃",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "VETS26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "blackfriday",
        start: new Date(2026, 10, 16),
        end: new Date(2026, 10, 29, 23, 59, 59),
        title: "BLACK FRIDAY SALE!",
        emoji: "🔥",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "BF26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "cybermonday",
        start: new Date(2026, 10, 30),
        end: new Date(2026, 11, 6, 23, 59, 59),
        title: "CYBER MONDAY SALE!",
        emoji: "💻",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "CM26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "xmas",
        start: new Date(2026, 11, 7),
        end: new Date(2026, 11, 27, 23, 59, 59),
        title: "CHRISTMAS SALE!",
        emoji: "🎄",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "XMAS26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "yearend",
        start: new Date(2026, 11, 28),
        end: new Date(2026, 11, 31, 23, 59, 59),
        title: "YEAR END SALE!",
        emoji: "🎇",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "END26",
        topBarBg: "#000000",
        highlightColor: "#ACF4A1",
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
      {
        name: "newyear2027",
        start: new Date(2027, 0, 1),
        end: new Date(2027, 0, 17, 23, 59, 59),
        title: "NEW YEAR SALE!",
        emoji: "🎆",
        offer1: "GET 1x FOR 63% OFF",
        offer2: "3x FOR 69% OFF",
        promoCode: "NEWYEAR27",
        topBarBg: '#000000',
        highlightColor: '#ACF4A1',
        bannerText: "WITH CODE:",
        bannerTextSec: "ORDER YOURS NOW",
        limitedTime: "LIMITED TIME",
      },
    ];

    // If forceSale parameter exists, find and return that sale (date-independent)
    // force-sale="default" skips the sales lookup and falls through to the default return
    if (forceSale && forceSale !== 'default') {
      const forcedSale = sales.find((sale) => sale.name === forceSale);
      if (forcedSale) {
        return {
          ...forcedSale,
          endDate: forcedSale.end,
          showTopBar: applyTopBar(true),
          showTimer: true,
        };
      }
    }

    // Find the current active sale (skipped if force-sale="default")
    for (const sale of (forceSale === 'default' ? [] : sales)) {
      if (now >= sale.start && now <= sale.end) {
        return {
          ...sale,
          endDate: sale.end,
          showTopBar: applyTopBar(true),
          showTimer: true,
        };
      }
    }

    // Return default banner if no sale is active
    return {
      name: 'default',
      title: '',
      emoji: '',
      offer1: '',
      offer2: '',
      promoCode: 'XXCODE',
      topBarBg: '',
      highlightColor: '',
      showTopBar: applyTopBar(false),
      showTimer: false,
      endDate: null,
      bannerText: 'USE PROMO CODE:',
      bannerTextSec: 'GET UP TO 69% OFF NOW!',
      limitedTime: '- LIMITED TIME OFFER',
    };
  }

  startTimer(endDate) {
    const updateTimer = () => {
      const now = new Date();
      const diff = endDate - now;

      if (diff <= 0) {
        clearInterval(this.timerInterval);
        this.updateTimerDisplay(0, 0, 0, 0);
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        (diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
      );
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      this.updateTimerDisplay(days, hours, minutes, seconds);
    };

    updateTimer();
    this.timerInterval = setInterval(updateTimer, 1000);
  }

  updateTimerDisplay(days, hours, minutes, seconds) {
    const daysEl = this.shadowRoot.getElementById('days');
    const hoursEl = this.shadowRoot.getElementById('hours');
    const minutesEl = this.shadowRoot.getElementById('minutes');
    const secondsEl = this.shadowRoot.getElementById('seconds');

    if (daysEl) daysEl.textContent = String(days).padStart(2, '0');
    if (hoursEl) hoursEl.textContent = String(hours).padStart(2, '0');
    if (minutesEl) minutesEl.textContent = String(minutes).padStart(2, '0');
    if (secondsEl) secondsEl.textContent = String(seconds).padStart(2, '0');
  }

  disconnectedCallback() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
  }
}

customElements.define('promo-banner', PromoBanner);
