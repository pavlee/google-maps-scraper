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
        // Get the first db and do an update document on it
        mainLoop(db.db("places"))
    })
})();

async function mainLoop(db) {
    const placeCategories = ["Bars", "Restaurants", "Takeout", "Groceries", "Hotels", "Banks"]
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    let rawData = fs.readFileSync('starting-points.json')
    let startingPoints = JSON.parse(rawData)
    let currentPage = 0;

    for (let startPoint of startingPoints) {
        for (let category of placeCategories) {
            let siteUrl = 'https://www.google.com/maps/place/' + category + '/@' + startPoint.lat + "," + startPoint.long;
            console.log('Scraping places in category "' + category + '" from the starting point of ' + startPoint.name + ". URL: " + siteUrl)
            await page.goto(siteUrl);
            await new Promise(resolve => setTimeout(resolve, 5000))
            do {
                console.log("Scraping page " + 0)
                const placeNames = await page.$$eval('.section-result', divs => divs.map(div => div.getAttribute('aria-label')))
                console.log("Places found: " + placeNames.length)

                for (let i = 0; i < placeNames.length; i++) {
                    await page.click('.section-result[data-result-index="' + (i+1) + '"]')
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    await page.waitForSelector('.section-back-to-list-button')

                    if (await withinBounds(page)) {
                        const place = await scrapePlaceData(page)
                        console.log(place)
                        let result = await db.collection('places').find({ coordinates: { $all: place.coordinates }})
                        console.log("Count: " + await result.count())
                        if (!await result.count())
                            db.collection('places').insert(place)
                        else
                            console.log("Place with coordinates " + place.coordinates + " already in the database")
                    }
                    await page.click('.section-back-to-list-button')
                    await new Promise(resolve => setTimeout(resolve, 1500))
                    await page.waitForSelector('.section-result')
                };

                await page.click('button[aria-label*="Next page"]')
                await new Promise(resolve => setTimeout(resolve, 5000))
                //page.waitForNavigation({ waitUntil: "networkidle0" }),
            } while (await page.waitForSelector('button[aria-label*="Next page"]'));
        }
    }

    await browser.close();
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
    return place;
}

const withinBounds = async (page) => {
    const url = page.url()
    const coordinates = url.substr(url.lastIndexOf('!3d') + 3).split('!4d')
    const point = { y: coordinates[0], x: coordinates[1] }
    return point.x > sqrMNE.topLeft.x && point.x < sqrMNE.bottomRight.x && point.y < sqrMNE.topLeft.y && point.y > sqrMNE.bottomRight.y;
}