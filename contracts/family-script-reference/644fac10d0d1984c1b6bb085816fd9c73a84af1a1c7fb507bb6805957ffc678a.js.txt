window.addEventListener('next:initialized', function() {

  // Image-only exit intent — replace with your own image URL
  // Coupon must exist on the campaign (Campaigns app → discount code offer, e.g. EXIT10)
  initExitIntentImage('https://placehold.co/600x400', async () => {
    await next.applyCoupon('EXIT10');
  });
});
