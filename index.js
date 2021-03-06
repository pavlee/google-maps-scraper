const puppeteer = require('puppeteer');
const fs = require('fs');
const MongoClient = require('mongodb').MongoClient;
const Server = require('mongodb').Server;

const sqrMNE = {
    topLeft: { y: 43.577914, x: 18.389149 },
    topRight: { y: 43.577914, x: 20.389149 },
    bottomLeft: { y: 41.85, x: 18.389149 },
    bottomRight: { y: 41.85, x: 20.389149 }
};

(async () => {
    // Open the connection to the server
    MongoClient.connect('mongodb://admin:admin@localhost:27017/', (err, db) => {
        mainLoop(db.db("places"))
    })
})();

async function mainLoop(db) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    let siteUrl = 'https://www.google.com/maps/@42.4378146,19.2625154,15z';
    await page.goto(siteUrl);
    await new Promise(resolve => setTimeout(resolve, 2000))

    let rawData = fs.readFileSync('starting-points.json')
    let startingPoints = JSON.parse(rawData)
    let currentPage = 0;

    for (let startPoint of startingPoints) {
        const searchInput = await page.$('.tactile-searchbox-input');
        await searchInput.click({ clickCount: 3 })
        await searchInput.type(startPoint.name);
        
        await page.keyboard.press(String.fromCharCode(13)) // press enter
        await new Promise(resolve => setTimeout(resolve, 3000))

        await page.click('button[data-value="Nearby"]')
        await new Promise(resolve => setTimeout(resolve, 2000))

        let placeCategories = await page.$$('.suggestions .sbsb_c')        

        for (let category of placeCategories) {
            await category.click()
            await new Promise(resolve => setTimeout(resolve, 5000))
            let pageCounter = 1;
            do {
                console.log("Scraping page " + pageCounter)
                const placeNames = await page.$$eval('.section-result', divs => divs.map(div => div.getAttribute('aria-label')))
                console.log("Places found: " + placeNames.length)

                for (let i = 0; i < placeNames.length; i++) {
                    try {
                        await page.click('.section-result[data-result-index="' + (i+1) + '"]')
                    } catch (e) {
                        console.log("error processing place " + (i+1))
                        continue;
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    await page.waitForSelector('.section-back-to-list-button')

                    if (await withinBounds(page)) {
                        const place = await scrapePlaceData(page)
                        console.log(place)
                        await savePlace(db, place)
                    }
                    await page.click('.section-back-to-list-button')
                    await new Promise(resolve => setTimeout(resolve, 1500))
                    await page.waitForSelector('.section-result')
                };

                pageCounter++
                await page.click('button[aria-label*="Next page"]')
                await new Promise(resolve => setTimeout(resolve, 5000))
                //page.waitForNavigation({ waitUntil: "networkidle0" }),
            } while (await page.waitForSelector('button[aria-label*="Next page"]'));
        }
    }

    await browser.close();
}

const savePlace = async (db, place) => {
    let result = await db.collection('places').find({ coordinates: { $all: place.coordinates }})
    console.log("Exists in the database: " + await result.count()==1 ? 'Yes' : 'No')
    if (!await result.count()) {
        let reviews = place.reviews
        place.reviews = undefined
        place = await db.collection('places').insertOne(place)
        
        for (let review of reviews) {
            review.place_id = place.insertedId
        }

        db.collection('reviews').insert(reviews)
    } else {
        console.log("Place with coordinates " + place.coordinates + " already in the database")
    }
}

const scrapePlaceData = async (page) => {
    let place = {}
    const nameSelector = '.section-hero-header-title-top-container h1 > span';
    if (await page.$(nameSelector)) {
        const name = await page.$eval(nameSelector, name => name.textContent)
        place.name = name
    }

    const categorySelector = '.section-rating div:nth-child(2) button.widget-pane-link';
    if (await page.$(categorySelector)) {
        const category = await page.$eval(categorySelector, category => category.textContent)
        place.category = category
    }

    const reviewSelector = '.section-rating div:nth-child(1) button.widget-pane-link';
    if (await page.$(reviewSelector)) {
        const noOfReviews = await page.$eval(reviewSelector, reviews => reviews.textContent.split(' ')[0])
        place.noOfReviews = noOfReviews
    }

    let addressHandles = await page.$x('.//button[@data-item-id="address"]')
    if (addressHandles.length > 0) {
        let fullAddress = await page.evaluate(a => a.textContent, addressHandles[0])
        fullAddress = fullAddress.replace('Address: ', '').split(',').map(s => s.trim())

        let di = 0;
        let address, city, country = null

        // location info specificity can vary
        if (fullAddress.length == 3)
            address = fullAddress[di++]
        if (fullAddress.length >= 2)
            city = fullAddress[di++]
        if (fullAddress.length >= 1)
            country = fullAddress[di++]

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

    const plusCodeSelector = 'button[aria-label^="Plus code"';
    if (await page.$(plusCodeSelector)) {
        const plusCode = await page.$eval(plusCodeSelector, reviews => reviews.getAttribute('aria-label').replace('Plus code: ', '').split(' ')[0])
        place.plusCode = plusCode
    }

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

    const url = page.url()
    place.coordinates = url.substr(url.lastIndexOf('!3d') + 3).split('!4d')
    let reviews = await scrapeReviews(page)
    place.reviews = reviews
    return place
}

const scrapeReviews = async (page) => {
    let reviews = []
    const reviewsBtn = await page.$('button[aria-label*="reviews"]')
    await reviewsBtn.click()
    await new Promise(resolve => setTimeout(resolve, 1000))

    await autoScroll(page)

    let reviewHandles = await page.$$('.section-review-content') // selector to get the list of reviews at this point
    if (reviewHandles) 
    for (let reviewHandle of reviewHandles) {
        let review = {}
        const titleSelector = '.section-review-title span';
        if (await reviewHandle.$(titleSelector)) {
            const title = await reviewHandle.$eval(titleSelector, span => span.textContent);
            review.title = title
        }

        const subtitle1Selector = '.section-review-subtitle span:nth-child(1)';
        if (await reviewHandle.$(subtitle1Selector)) {
            const subtitle1 = await reviewHandle.$eval(subtitle1Selector, span => span.textContent);
            review.subtitle1 = subtitle1
        }

        const subtitle2Selector = '.section-review-subtitle span:nth-child(2)';
        if (await reviewHandle.$(subtitle2Selector)) {
            const subtitle2 = await reviewHandle.$eval(subtitle2Selector, span => span.textContent);
            review.subtitle2 = subtitle2
        }

        const reviewTextSelector = '.section-review-text';
        if (await reviewHandle.$(reviewTextSelector)) {
            const reviewText = await reviewHandle.$eval(reviewTextSelector, span => span.textContent);
            review.reviewText = reviewText
        }

        const starsSelector = '.section-review-stars .section-review-star-active'; 
        const starsHandle = await reviewHandle.$$(starsSelector);
        if (starsHandle) {
            review.stars = starsHandle.length
        }

        reviews.push(review)
        console.log(review)
    }

    const backBtn = await page.$('button.mdc-icon-button')
    await backBtn.click()
    await new Promise(resolve => setTimeout(resolve, 4000))

    return reviews
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
            var lastTotalHeight = 0;
            var timer = setInterval(() => {
                let reviewScrollable = document.querySelector('.section-layout.section-scrollbox.scrollable-y.scrollable-show')
                var scrollHeight = document.querySelector('.section-layout-root .section-layout').scrollHeight;
                if (scrollHeight == lastTotalHeight) {
                    clearInterval(timer);
                    resolve();
                }
                lastTotalHeight = scrollHeight
                reviewScrollable.scrollBy(0, 150000)
            }, 2000);
        });
    });
}

const withinBounds = async (page) => {
    const url = page.url()
    const coordinates = url.substr(url.lastIndexOf('!3d') + 3).split('!4d')
    const point = { y: coordinates[0], x: coordinates[1] }
    return point.x > sqrMNE.topLeft.x && point.x < sqrMNE.bottomRight.x && point.y < sqrMNE.topLeft.y && point.y > sqrMNE.bottomRight.y;
}