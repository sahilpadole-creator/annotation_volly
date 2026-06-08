import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER_CONSOLE:', msg.text()));
  page.on('pageerror', error => console.log('BROWSER_ERROR:', error.message));

  await page.goto('http://localhost:5173/annotation_volly/', { waitUntil: 'networkidle0' });

  console.log("Page loaded. Uploading files...");
  
  const fileInput = await page.$('input[type="file"][webkitdirectory]');
  if (fileInput) {
    await fileInput.uploadFile(
      '/home/sahil-padole/Documents/two_full_annotation_matches/touch_player_annotator/touch-player-tracking-data/volleymetrics-new-mathces/765873/upload/rally_105.mp4',
      '/home/sahil-padole/Documents/two_full_annotation_matches/touch_player_annotator/touch-player-tracking-data/volleymetrics-new-mathces/765873/upload/rally_105_resync_v2.json'
    );
    console.log("Files uploaded!");
  } else {
    console.log("Could not find directory file input.");
  }

  // Wait for up to 90 seconds for batch processing to finish (we know it takes ~62 seconds)
  await new Promise(r => setTimeout(r, 75000));

  console.log("Done waiting. Taking screenshot...");
  await page.screenshot({ path: 'test_shot.png' });

  await browser.close();
})();
