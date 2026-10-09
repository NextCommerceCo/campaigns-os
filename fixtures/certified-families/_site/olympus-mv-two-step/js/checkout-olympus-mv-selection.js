function handleStepTransition() {
  const btn = document.querySelector('[data-next-action="select-variants"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const loader = btn.querySelector('[data-next-component="loader"]');
    const info = btn.querySelector('[data-next-component="button-info"]');
    if (loader) loader.style.display = 'flex';
    if (info) info.style.display = 'none';

    setTimeout(() => {
      const stepTwo = document.querySelector('[data-next-component="step-two"]');
      if (stepTwo) {
        stepTwo.classList.remove('is-inactive');
        stepTwo.classList.add('step-revealed');
      }
      const quantityCta = document.querySelector('[data-next-component="quantity-cta"]');
      if (quantityCta) quantityCta.style.display = 'none';

      setTimeout(() => {
        if (stepTwo) stepTwo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }, 1000);
  });
}

function handleCheckoutNavigate() {
  const btn = document.querySelector('[data-next-action="checkout"]');
  if (!btn) return;
  // The button is a real link to the next step (href from the page's next_step).
  // next-success-url is where payment leads, not the next step, so it is never read here.
  btn.addEventListener('click', (event) => {
    const href = btn.getAttribute('href');
    if (!href) return;
    event.preventDefault();

    const spinner = btn.querySelector('[data-pb-element="checkout-button-spinner"]');
    const info = btn.querySelector('[data-pb-element="checkout-button-info"]');
    if (spinner) spinner.style.display = '';
    if (info) info.style.display = 'none';

    // Carry this page's query params (currency, country, UTMs) to the checkout step,
    // as the SDK does for data-next-checkout-step navigation.
    const url = new URL(href, window.location.href);
    new URLSearchParams(window.location.search).forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    });
    window.location.href = url.toString();
  });
}

function autoRevealStepTwo() {
  const stepTwo = document.querySelector('[data-next-component="step-two"]');
  if (!stepTwo) return;
  stepTwo.classList.remove('is-inactive');
  stepTwo.style.animation = 'none';
  const quantityCta = document.querySelector('[data-next-component="quantity-cta"]');
  if (quantityCta) quantityCta.style.display = 'none';
}

function resetButtonSpinners() {
  const checkoutSpinner = document.querySelector('[data-pb-element="checkout-button-spinner"]');
  const checkoutInfo = document.querySelector('[data-pb-element="checkout-button-info"]');
  if (checkoutSpinner) checkoutSpinner.style.display = 'none';
  if (checkoutInfo) checkoutInfo.style.display = '';

  const selectLoader = document.querySelector('[data-next-action="select-variants"] [data-next-component="loader"]');
  const selectInfo = document.querySelector('[data-next-action="select-variants"] [data-next-component="button-info"]');
  if (selectLoader) selectLoader.style.display = 'none';
  if (selectInfo) selectInfo.style.display = '';
}

window.addEventListener('next:initialized', () => {
  handleStepTransition();
  handleCheckoutNavigate();
  initExitIntentImage('https://placehold.co/600x400', async () => {
    await next.applyCoupon('EXIT10');
  });
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    resetButtonSpinners();
    autoRevealStepTwo();
  }
});
