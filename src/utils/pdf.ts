import puppeteer from 'puppeteer';

export const createPdf = async (html: string): Promise<Buffer> => {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    const browser = await puppeteer.launch({
        executablePath: executablePath || undefined,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });

    try {
        const page = await browser.newPage();
        await page.setContent(`<html><body>${html}</body></html>`, { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({ format: 'A4' });
        return Buffer.from(pdfBuffer);
    } finally {
        await browser.close();
    }
};
