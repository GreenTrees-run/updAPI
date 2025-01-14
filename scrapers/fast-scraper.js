import { CheerioCrawler } from 'crawlee';
import { parse } from 'csv-parse';
import fs from 'fs';
import path from 'path';

// Function to parse CSV into JSON
const parseCSV = async (filePath) => {
    return new Promise((resolve, reject) => {
        const records = [];
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true }))
            .on('data', (data) => records.push(data))
            .on('end', () => resolve(records))
            .on('error', (error) => reject(error));
    });
};

// Function to check `robots.txt`
const canScrape = async (url) => {
    try {
        const robotsUrl = new URL('/robots.txt', url).href;
        const response = await fetch(robotsUrl);
        if (!response.ok) {
            console.warn(`Could not fetch robots.txt for ${url}. Defaulting to allow.`);
            return true; // Default to allow if robots.txt is not reachable
        }
        const robotsText = await response.text();
        return !robotsText.includes('Disallow: /'); // Check for broad disallow
    } catch (err) {
        console.error(`Error checking robots.txt for ${url}: ${err.message}`);
        return false;
    }
};

// Check `robots.txt` and enqueue URLs
const checkRobotsAndEnqueue = async (apis, crawler) => {
    // Create a list of promises to check robots.txt for all URLs
    const promises = apis.map(async (api) => {
        const { API_Name, Official_Documentation_URL } = api;
        const canScrapeResult = await canScrape(Official_Documentation_URL);

        if (canScrapeResult) {
            // If allowed by robots.txt, enqueue the URL
            crawler.addRequests([{
                url: Official_Documentation_URL,
                userData: { apiName: API_Name },
            }]);
            console.log(`Enqueued: ${Official_Documentation_URL}`);
        } else {
            // Log if the URL is not allowed by robots.txt
            console.warn(`Skipping ${Official_Documentation_URL}: Not allowed by robots.txt`);
        }
    });

    // Wait for all promises to resolve
    await Promise.all(promises);
};

// Function to clean up invalid JSON files, move valid ones, and delete the storage folder
const cleanUpAndMoveFiles = () => {
    const directoryPath = './storage/request_queues/default';
    const destinationPath = './datasets';

    // Check if datasets folder exists, otherwise create it
    if (!fs.existsSync(destinationPath)) {
        fs.mkdirSync(destinationPath, { recursive: true });
    }

    // Function to generate timestamp in MMDDYYHHMMSS format
    const generateTimestamp = () => {
        const now = new Date();
        const month = (now.getMonth() + 1).toString().padStart(2, '0'); // MM
        const day = now.getDate().toString().padStart(2, '0'); // DD
        const year = now.getFullYear().toString().slice(-2); // YY
        const hours = now.getHours().toString().padStart(2, '0'); // HH
        const minutes = now.getMinutes().toString().padStart(2, '0'); // MM
        const seconds = now.getSeconds().toString().padStart(2, '0'); // SS
        return `${month}${day}${year}${hours}${minutes}${seconds}`;
    };

    // Read all files in the directory
    fs.readdirSync(directoryPath).forEach(file => {
        const filePath = path.join(directoryPath, file);
        const destinationFilePath = path.join(destinationPath, file);

        // Only process JSON files
        if (file.endsWith('.json')) {
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                // Check if required fields exist and if the title contains '404'
                if (!data.apiName || !data.url || !data.title || !data.content || data.title.includes('404')) {
                    console.log(`Deleting invalid file: ${file}`);
                    fs.unlinkSync(filePath); // Delete the file if it doesn't contain required fields
                } else {
                    // Check if a file with the same name already exists in the destination
                    if (fs.existsSync(destinationFilePath)) {
                        const extname = path.extname(file);
                        const basename = path.basename(file, extname);
                        const timestamp = generateTimestamp(); // Use MMDDYYHHMMSS format
                        const newFileName = `${basename}_${timestamp}${extname}`;
                        const newFilePath = path.join(destinationPath, newFileName);
                        fs.renameSync(filePath, newFilePath);
                        console.log(`File with the same name exists. Moved and renamed: ${newFileName}`);
                    } else {
                        // Move valid files to the datasets directory
                        fs.renameSync(filePath, destinationFilePath);
                        console.log(`Moved valid file: ${file}`);
                    }
                }
            } catch (error) {
                console.error(`Error reading or parsing file ${file}: ${error.message}`);
            }
        }
    });

    // Delete the storage folder after moving valid files
    try {
        fs.rmSync('./storage', { recursive: true });
        console.log('Deleted the storage folder after moving valid files.');
    } catch (error) {
        console.error(`Error deleting the storage folder: ${error.message}`);
    }
};

// Main scraper function
const scrapeDocs = async () => {
    // Load API URLs from CSV
    const apis = await parseCSV('./api-docs-urls.csv');
    console.log(`Loaded ${apis.length} API URLs.`);

    const crawler = new CheerioCrawler({
        async requestHandler({ request, $, log }) {
            // Extract relevant content
            const title = $('title').text();
            const content = $('body').text().trim();

            // Create a custom dataset filename from the API name
            const apiNameFormatted = request.userData.apiName.replace(/ /g, '_');
            const datasetPath = path.join('./storage/request_queues/default', `${apiNameFormatted}.json`);

            // Ensure the datasets folder exists
            if (!fs.existsSync('./storage/request_queues/default')) {
                fs.mkdirSync('./storage/request_queues/default');
            }

            // Save scraped data to a file
            fs.writeFileSync(datasetPath, JSON.stringify({
                apiName: request.userData.apiName,
                url: request.url,
                title,
                content,
            }, null, 2));

            log.info(`Scraped: ${request.url}`);
        },
        failedRequestHandler({ request }, error ) {
            console.error(`Failed to scrape ${request.url}: ${error.message}`);
        },
    });

    // Check `robots.txt` and enqueue URLs concurrently, passing the `crawler` instance
    await checkRobotsAndEnqueue(apis, crawler);

    // Run the crawler
    await crawler.run();

    // Clean up invalid files and move valid files after scraping
    cleanUpAndMoveFiles();
};

// Run the scraper
scrapeDocs().then(() => {
    console.log('Scraping completed. Datasets saved in ./datasets');
});
