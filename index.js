const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://www.google.com/maps/search/Bars+and+pubs/@42.4323168,19.185324,12z');

    const placeNames = await page.$$eval('.section-result', divs => divs.map(div => div.getAttribute('aria-label')));
    console.log("Places found: " + placeNames.length);

    while (await page.waitForSelector('button[aria-label*="Next page"]')) {
        for( let i = 0; i < placeNames.length; i++ ) {
            console.log("Loop " + i);
            await page.click('.section-result[data-result-index="' + (i+1) + '"]')
            await page.waitForSelector('.section-back-to-list-button')

            const place = await scrapePlaceData(page)
            console.log(place)

            await page.click('.section-back-to-list-button')
            await page.waitForSelector('.section-result')
        };
    }
    await browser.close();
})();

const scrapePlaceData = async (page) => {
    let place = {}

    const name = await page.$eval('.section-hero-header-title-top-container h1 > span', name => name.textContent)
    place.name = name

    const category = await page.$eval('.section-rating div:nth-child(2) button.widget-pane-link', category => category.textContent)
    place.category = category

    const noOfReviews = await page.$eval('.section-rating div:nth-child(1) button.widget-pane-link', reviews => reviews.textContent.split(' ')[0])
    place.noOfReviews = noOfReviews

    let addressHandles = await page.$x('.//button[@data-item-id="address"]')
    if (addressHandles.length > 0) {
        let fullAddress = await page.evaluate(a => a.textContent, addressHandles[0])
        fullAddress = fullAddress.replace('Address: ', '').split(',').map(s => s.trim())

        const address = fullAddress[0]
        const city = fullAddress[1]
        const country = fullAddress[2]

        place.address = address
        place.city = city
        place.country = country
    }
    
    const ratingHandles = await page.$x('.//span[contains(@class, "section-star-display")]')
    if (ratingHandles.length > 0) {
        const rating = await page.evaluate(r => r.textContent, ratingHandles[0]);
        place.rating = rating
    }

    const phoneHandler = await page.$x('.//button[contains(@data-item-id, "phone:tel:")]')
    if (phoneHandler.length > 0) {
        const phone = await page.evaluate(p => p.getAttribute('data-item-id'), phoneHandler[0])
        place.phone = phone.replace('phone:tel:', '').trim()
    }
    
    const websiteHandler = await page.$x('.//button[contains(@data-item-id, "authority")]')
    if (websiteHandler.length > 0) {
        const website = await page.evaluate(w => w.getAttribute('aria-label'), websiteHandler[0])
        place.website = website.replace('Website: ', '').trim()
    }

    const plusCode = await page.$eval('button[aria-label^="Plus code"', reviews => reviews.getAttribute('aria-label').replace('Plus code: ', '').split(' ')[0])
    place.plusCode = plusCode

    const openDays = await page.$$eval('.section-open-hours-container table th > div:nth-child(1)', divs => divs.map(div => div.textContent))
    const openTimes = await page.$$eval('.section-open-hours-container table td ul li', lis => lis.map(li => li.textContent))

    if (openDays) {
        place.open = []
        for (let i=0; i < openDays.length; i++) {
            const day = openDays[i]
            const open = openTimes[i].split('\–')[0]
            const close = openTimes[i].split('\–')[1]
            place.open.push({ day: day, open: open, close: close })
        }
    }

    return place;
}