/**
 * <promo-timer> — Promo code countdown timer web component
 *
 * Displays the active promo code with a countdown timer (resets every hour).
 * Automatically picks the current seasonal promo code, or falls back to the
 * default code when no sale is running.
 *
 * ─── BASIC USAGE ────────────────────────────────────────────────────────────
 *
 *   <promo-timer></promo-timer>
 *
 * ─── CONTROLLING FROM FRONTMATTER ───────────────────────────────────────────
 *
 *   ---
 *   promo_sale: "blackfriday"   ← force a specific sale's promo code
 *   ---
 *
 *   <promo-timer
 *     {% if promo_sale %}force-sale="{{ promo_sale }}"{% endif %}
 *   ></promo-timer>
 *
 * Tip: use the same promo_sale value on both <promo-banner> and <promo-timer>
 * so both components show the same code.
 *
 * ─── HTML ATTRIBUTES ────────────────────────────────────────────────────────
 *
 *   force-sale="blackfriday"   Force a named sale's promo code regardless of
 *                              the current date. Any unrecognised name falls
 *                              back to the default code.
 *
 *   force-sale="default"       Force the generic default promo code.
 *
 * ─── URL PARAMS (preview overrides) ──────────────────────────────────────────────
 *
 *   ?sale=blackfriday          Same as force-sale attribute — useful for previews
 *   ?sale=default              Force the default promo code via URL
 *
 *   URL params always take priority over attributes for easy previews.
 *
 * ─── SALE NAMES (for force-sale / ?sale=) ───────────────────────────────────
 *
 *   newyear · valentinesday · stpatricks · easter · mothersday · memorialday
 *   fathersday · 4thofjuly · summersale · backtoschool · halloween
 *   veteransday · blackfriday · cybermonday · xmas · yearend · newyear2027
 *
 * ─── ADDING OR EDITING A SALE ───────────────────────────────────────────────
 *
 * Keep this list in sync with promo-banner.js. Each entry needs:
 *
 *   {
 *     name: "summersale",               ← must match the name in promo-banner.js
 *     start: new Date(2026, 5, 15),     ← month is 0-indexed (0 = Jan, 5 = Jun)
 *     end:   new Date(2026, 7, 30, 23, 59, 59),
 *     promoCode: "SUMMER26",            ← code shown in the "PROMO APPLIED" pill
 *   }
 *
 * ────────────────────────────────────────────────────────────────────────────
 */
class PromoTimer extends HTMLElement {
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

        .timer-container {
          display: flex;
          font-style: normal;
          padding: 5px 0 10px;
          font-weight: 700;
          font-size: 14px;
        }

        .timer-container p {
          margin: 0;
        }

        .timer-code {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: var(--brand--color--primary, #000000);
          color: var(--brand--color--white, #ffffff);
          box-sizing: border-box;
          width: 160px;
          padding: 3px 0px;
          border-top-left-radius: var(--radius--cards);
          border-bottom-left-radius: var(--radius--cards);
        }

        .timer-message {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          background-color: var(--brand--color--primary-light, #acf4a1);
          color: #000000;
          box-sizing: border-box;
          flex-grow: 1;
          padding: 0 10px;
          border-top-right-radius: var(--radius--cards);
          border-bottom-right-radius: var(--radius--cards);
        }

        .timer-code__label {
          color: var(--brand--color--white, #acf4a1);
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .timer-code__label svg {
          flex-shrink: 0;
        }

        #timer-countdown {
          display: inline-block;
          color: #e44613;
          width: 41px;
          font-size: 14px;
        }

        .timer-message__text {
          font-size: 12.8px;
        }

        @media screen and (max-width: 768px) {
          .timer-message {
            padding-left: 15px;
          }
          .timer-container {
            font-size: 12px;
          }
          .timer-code {
          text-align: center;
            padding: 3px 3px;
          }
        }
      </style>

      <div class="timer-container">
        <div class="timer-code">
          <p class="timer-code__label">
            <svg width="12" height="10" viewBox="0 0 12 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10.5 0L4.11353 6.92234L1.32353 4.50842L0 6.30069L3.52941 9.36113L4.26882 10L4.94118 9.27123L12 1.62012L10.5 0Z" fill="currentColor"></path>
            </svg>
            ${saleConfig.promoCode}
          </p>
          <p>PROMO APPLIED</p>
        </div>
        <div class="timer-message">
          <p class="timer-message__text">
            Promo code expires in: <span id="timer-countdown">08:59</span>. Stay on this page
          </p>
        </div>
      </div>
    `;

    this.startTimer();
  }

  getCurrentSale() {
    const now = new Date();

    // URL param takes priority, then attribute preview override
    const urlParams = new URLSearchParams(window.location.search);
    const forceSale = urlParams.get('sale') || this.getAttribute('force-sale');

    // ─── Sale schedule ───────────────────────────────────────────────────────
    // Keep in sync with promo-banner.js. Months are 0-indexed: 0=Jan … 11=Dec.
    const sales = [
      {
        name: "newyear",
        start: new Date(2025, 11, 26),
        end: new Date(2026, 0, 14, 23, 59, 59),
        promoCode: "NEWYEAR26",
      },
      {
        name: "valentinesday",
        start: new Date(2026, 1, 6),
        end: new Date(2026, 1, 15, 23, 59, 59),
        promoCode: "LOVE26",
      },
      {
        name: "stpatricks",
        start: new Date(2026, 2, 9),
        end: new Date(2026, 2, 22, 23, 59, 59),
        promoCode: "LUCKY26",
      },
      {
        name: "easter",
        start: new Date(2026, 2, 30),
        end: new Date(2026, 3, 12, 23, 59, 59),
        promoCode: "EASTER26",
      },
      {
        name: "mothersday",
        start: new Date(2026, 3, 15),
        end: new Date(2026, 4, 17, 23, 59, 59),
        promoCode: "MOM26",
      },
      {
        name: "memorialday",
        start: new Date(2026, 4, 22),
        end: new Date(2026, 4, 31, 23, 59, 59),
        promoCode: "MEMORIAL26",
      },
      {
        name: "fathersday",
        start: new Date(2026, 5, 15),
        end: new Date(2026, 5, 22, 23, 59, 59),
        promoCode: "DAD26",
      },
      {
        name: "4thofjuly",
        start: new Date(2026, 5, 22),
        end: new Date(2026, 6, 5, 23, 59, 59),
        promoCode: "FREEDOM26",
      },
      {
        name: "summersale",
        start: new Date(2026, 6, 15),
        end: new Date(2026, 7, 30, 23, 59, 59),
        promoCode: "SUMMER26",
      },
      {
        name: "backtoschool",
        start: new Date(2026, 7, 31),
        end: new Date(2026, 8, 13, 23, 59, 59),
        promoCode: "SCHOOL26",
      },
      {
        name: "halloween",
        start: new Date(2026, 9, 26),
        end: new Date(2026, 10, 1, 23, 59, 59),
        promoCode: "SPOOKY26",
      },
      {
        name: "veteransday",
        start: new Date(2026, 10, 6),
        end: new Date(2026, 10, 10, 23, 59, 59),
        promoCode: "VETS26",
      },
      {
        name: "blackfriday",
        start: new Date(2026, 10, 16),
        end: new Date(2026, 10, 29, 23, 59, 59),
        promoCode: "BF26",
      },
      {
        name: "cybermonday",
        start: new Date(2026, 10, 30),
        end: new Date(2026, 11, 6, 23, 59, 59),
        promoCode: "CM26",
      },
      {
        name: "xmas",
        start: new Date(2026, 11, 7),
        end: new Date(2026, 11, 27, 23, 59, 59),
        promoCode: "XMAS26",
      },
      {
        name: "yearend",
        start: new Date(2026, 11, 28),
        end: new Date(2026, 11, 31, 23, 59, 59),
        promoCode: "END26",
      },
      {
        name: "newyear2027",
        start: new Date(2027, 0, 1),
        end: new Date(2027, 0, 17, 23, 59, 59),
        promoCode: "NEWYEAR27",
      },
    ];

    // If forceSale parameter exists, find and return that sale (date-independent)
    // force-sale="default" skips the lookup and falls through to the default return
    if (forceSale && forceSale !== 'default') {
      const forcedSale = sales.find((sale) => sale.name === forceSale);
      if (forcedSale) return forcedSale;
    }

    // Find the current active sale (skipped if force-sale="default")
    if (forceSale !== 'default') {
      for (const sale of sales) {
        if (now >= sale.start && now <= sale.end) return sale;
      }
    }

    // Return default if no sale is active
    return { name: 'default', promoCode: 'XXCODE' };
  }

  startTimer() {
    let timeLeft = 60 * 60; // 1 hour in seconds, resets when it hits 0

    const updateTimer = () => {
      if (timeLeft <= 0) timeLeft = 60 * 60;

      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;

      const stopwatchEl = this.shadowRoot.getElementById('timer-countdown');
      if (stopwatchEl) {
        stopwatchEl.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }

      timeLeft--;
    };

    updateTimer();
    this.timerInterval = setInterval(updateTimer, 1000);
  }

  disconnectedCallback() {
    if (this.timerInterval) clearInterval(this.timerInterval);
  }
}

customElements.define('promo-timer', PromoTimer);
