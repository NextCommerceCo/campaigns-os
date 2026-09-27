window.addEventListener('next:initialized', function() {

  // Image-only exit intent — replace with your own image URL
  initExitIntentImage('https://placehold.co/600x400', async () => {
    await next.applyCoupon('EXIT10');
  });
});
