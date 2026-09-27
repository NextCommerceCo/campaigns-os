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
  btn.addEventListener('click', () => {
    const spinner = btn.querySelector('[data-pb-element="checkout-button-spinner"]');
    const info = btn.querySelector('[data-pb-element="checkout-button-info"]');
    if (spinner) spinner.style.display = '';
    if (info) info.style.display = 'none';

    const meta = document.querySelector('meta[name="next-success-url"]');
    const url = meta ? meta.getAttribute('content') : null;
    if (url) window.location.href = url;
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
