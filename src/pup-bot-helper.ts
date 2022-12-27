// @ts-nocheck

'use strict';

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import fs from "fs";
import proxyChainLib from 'proxy-chain';
import {BrowserMode} from "./browser-mode.js";
import Xvfb from 'xvfb';

export class PupBotHelper {

    browser: any;
    page: any;

    mode = BrowserMode.HEADLESS;

    xvfbInstance = null;

    currentUserAgent: string | null = null;

    useProxies = true;
    proxiesFilePath;
    proxiesList;

    proxyChainUrl: string | null = null;

    requestTimeout = 30000;
    disabledAssets = [];
    disabledHosts = [];
    isCacheDisabled = false;

    minWidth;
    minHeight;

    userAgentConfig = [
        /(Chrome)|(Chromium)/,
        {deviceCategory: 'desktop'}
    ];

    /**
     * Constructor with properties
     * @param options
     */
    constructor(options: any) {

        if (!options) {
            console.warn('Config is not specified for BrowserBot!');
            return;
        }

        if (options.useProxies !== undefined) {
            this.useProxies = options.useProxies;
        }

        if (options.proxiesList !== undefined) {
            this.proxiesList = options.proxiesList;
        }

        if (options.proxiesFilePath !== undefined) {
            this.proxiesFilePath = options.proxiesFilePath
        }

        if (options.requestTimeout !== undefined) {
            this.requestTimeout = options.requestTimeout;
        }

        if (options.disabledAssets !== undefined) {
            this.disabledAssets = options.disabledAssets;
        }

        if (options.disabledHosts !== undefined) {
            this.disabledHosts = options.disabledHosts;
        }

        if (options.isCacheDisabled !== undefined) {
            this.isCacheDisabled = options.isCacheDisabled;
        }

        if (options.userAgentConfig !== undefined) {
            this.userAgentConfig = options.userAgentConfig;
        }

        if (options.minWidth !== undefined) {
            this.minWidth = options.minWidth;
            // @ts-ignore
            this.userAgentConfig.push((userAgent) => {
                return userAgent.viewportWidth >= this.minWidth;
            });
        }

        if (options.minHeight !== undefined) {
            this.minHeight = options.minHeight;
            // @ts-ignore
            this.userAgentConfig.push((userAgent) => {
                return userAgent.viewportHeight >= this.minHeight;
            });
        }

        if (options.mode !== undefined) {
            this.mode = options.mode;
        }
    }

    /**
     * Method for default request interception behavior
     * @param request
     */
    getDefaultInterceptor(request: any) {

        const browserBot = this;
        return (request: any) => {
            const requestUrl = new URL(request.url());
            // @ts-ignore
            if (browserBot.disabledHosts.indexOf(requestUrl.host) !== -1) {
                request.abort();
            } else {
                // @ts-ignore
                if (browserBot.disabledAssets.indexOf(request.resourceType()) !== -1) {
                    request.abort();
                } else {
                    request.continue();
                }
            }
        };
    }

    /**
     * Method initialized browser and page
     * @returns {Promise<void>}
     */
    async initBrowser() {

        // destroy old instance
        await this.destroyBrowser();

        // browser config
        const browserArgs = [];

        // check proxies
        if (this.useProxies) {
            await this.initProxies();
            browserArgs.push('--proxy-server=' + this.proxyChainUrl);
        }

        // generate user agent finger print
        const userAgent = new UserAgent(this.userAgentConfig);
        this.currentUserAgent = userAgent;
        console.log(`Selected UA: ${userAgent.toString()}`);
        browserArgs.push(`--user-agent=${userAgent.toString()}`);

        // set window size
        const windowSizeWidth = userAgent.data.viewportWidth;
        const windowSizeHeight = userAgent.data.viewportHeight + 125;
        const windowSizeStr = `--window-size=${windowSizeWidth},${windowSizeHeight}`;
        browserArgs.push(windowSizeStr);

        // if cache disabled
        if (this.isCacheDisabled) {
            const disableCacheParams = [
                '--aggressive-cache-discard',
                '--disable-cache',
                '--disable-application-cache',
                '--disable-offline-load-stale-cache',
                '--disable-gpu-shader-disk-cache',
                '--media-cache-size=0',
                '--disk-cache-size=0',
            ];
            browserArgs.push(...disableCacheParams);
        }

        // depends on current mode we should disable notifications or not to avoid headless detection
        if (this.mode === BrowserMode.HEADLESS) {
            browserArgs.push('--disable-notifications');
        } else if (this.mode === BrowserMode.VIRTUAL_DISPLAY) {
            if (this.xvfbInstance) {
                // @ts-ignore
                this.xvfbInstance.stopSync();
            }
            this.xvfbInstance = new Xvfb({
                silent: true,
                xvfb_args: ['-screen', '0', `${windowSizeWidth}x${windowSizeHeight}x24`]
            });
            // @ts-ignore
            this.xvfbInstance.startSync();
            // @ts-ignore
            browserArgs.push(`--display=${this.xvfbInstance._display}`);
        }

        // other default staff
        browserArgs.push(...[

            // disable security for more power
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',

            // disabled sandbox
            '--no-sandbox',
            '--disable-setuid-sandbox',

            // Those parameters were added on the beginning to optimize speed. I am not sure did it help.
            // After upgrading to Puppeteer 14.4.0 those params made issues with displaying information
            // inside head-full Chrome.
            // That's why they were disabled.

            // '--disable-canvas-aa', // disable antialiasing on 2d canvas
            // '--disable-2d-canvas-clip-aa', // disable antialiasing on 2d canvas clips
            // '--disable-gl-drawing-for-tests', // disables GL drawing operations which produce pixel output.
            // '--use-gl=desktop', // for non headless mode testing

            '--no-first-run',
            '--hide-scrollbars',
            '--mute-audio',
            '--disable-infobars',
            '--disable-breakpad',
            '--disable-background-networking',

            // for making network requests
            '--enable-features=NetworkService',
        ]);

        // use stealth plugin
        puppeteer.use(StealthPlugin());

        // launch browser
        // @ts-ignore
        this.browser = await puppeteer.launch({
            args: browserArgs,
            headless: this.mode === BrowserMode.HEADLESS,
            defaultViewport: {
                width: userAgent.data.viewportWidth,
                height: userAgent.data.viewportHeight,
            },
        });

        // load main default page
        await this.setDefaultPage();
    }

    /**
     * Method do all necessary staff to init proxies
     * @returns {Promise<void>}
     */
    async initProxies() {

        if (!this.proxiesList || this.proxiesList.length === 0 && this.proxiesFilePath) {
            const proxiesData = fs.readFileSync(this.proxiesFilePath, 'utf8');
            this.proxiesList = proxiesData.split('\n').filter(proxy => proxy).map(proxy => proxy.trim());
        }

        const targetProxy = this.proxiesList[Math.floor(Math.random() * this.proxiesList.length)];

        console.log('Selected proxy: ' + targetProxy);

        let scheme = 'http';
        let urlNoScheme = targetProxy;
        let username = null;
        let password = null;

        if (targetProxy.includes('//')) {
            const schemaProxyParts = targetProxy.split('//');
            scheme = schemaProxyParts[0].replace(':', '');
            urlNoScheme = schemaProxyParts[1];
        }

        let proxyHost;
        let proxyPort;

        if (urlNoScheme.includes('@')) {
            const userProxyParts = urlNoScheme.split('@');
            const userPassParts = userProxyParts[0].split(':');
            username = userPassParts[0];
            password = userPassParts[1];
            const hostParts = userProxyParts[1].split(':');
            proxyHost = hostParts[0];
            proxyPort = hostParts[1];
        } else {
            const proxyUrlParts = urlNoScheme.split(':');
            proxyHost = proxyUrlParts[0];
            proxyPort = proxyUrlParts[1];
            if (proxyUrlParts.length === 4) {
                username = proxyUrlParts[2];
                password = proxyUrlParts[3];
            }
        }

        let finalProxyUrl;
        if (username && password) {
            finalProxyUrl = `${scheme}://${username}:${password}@${proxyHost}:${proxyPort}`;
        } else {
            finalProxyUrl = `${scheme}://${proxyHost}:${proxyPort}`;
        }

        this.proxyChainUrl = await proxyChainLib.anonymizeProxy(finalProxyUrl);
    }

    /**
     * Method load main page from current browser
     * @param {Page} page
     * @returns {Promise<void>}
     */
    async setDefaultPage(page = undefined) {

        if (page !== undefined) {
            this.page = page;
        } else {
            const pages = await this.browser.pages();
            this.page = pages[0];
            if (!this.page) {
                this.page = await this.browser.newPage();
            }
        }

        // set user agent and page settings
        // @ts-ignore
        await this.page.setUserAgent(this.currentUserAgent.toString());
        if (this.mode === BrowserMode.HEADLESS) {
            await this.modifyBrowserContext(this.page);
        }
        await this.page.setDefaultTimeout(this.requestTimeout);
        await this.page.setRequestInterception(true);
        // @ts-ignore
        this.page.on('request', this.getDefaultInterceptor());
    }

    /**
     * Method destroy browser
     * @returns {Promise<void>}
     */
    async destroyBrowser() {

        if (this.browser) {

            for (let page of await this.browser.pages()) {
                if (!page.isClosed()) {
                    await page.close({
                        "runBeforeUnload": true
                    });
                }
            }

            const process = await this.browser.process();
            await this.browser.close();
            if (process && process.pid && process.kill && !process.killed) {
                await process.kill("SIGKILL");
            }
        }

        if (this.proxyChainUrl) {
            await proxyChainLib.closeAnonymizedProxy(this.proxyChainUrl, true);
        }

        if (this.xvfbInstance) {
            this.xvfbInstance.stopSync();
        }
    }

    /**
     * Method create new page and return it
     * @returns {Promise<Page>}
     */
    async setupDefaultPage() {
        /** @type {Page} */
        const newPage = await this.browser.newPage();
        await newPage.setUserAgent(this.currentUserAgent.toString());
        if (this.mode === BrowserMode.HEADLESS) {
            await this.modifyBrowserContext(this.page);
        }
        await newPage.setDefaultTimeout(this.requestTimeout);
        await newPage.setRequestInterception(true);
        newPage.on('request', this.getDefaultInterceptor());
        return newPage;
    }

    /**
     * Method create new page and return it
     * @returns {Promise<Page>}
     */
    async setupPageWithoutInterceptor() {
        /** @type {Page} */
        const newPage = await this.browser.newPage();
        await newPage.setUserAgent(this.currentUserAgent.toString());
        if (this.mode === BrowserMode.HEADLESS) {
            await this.modifyBrowserContext(this.page);
        }
        await newPage.setDefaultTimeout(this.requestTimeout);
        return newPage;
    }

    /**
     * Function set different value of the browser page to correct value.
     * It helps avoid detection of headless browser.
     *
     * @param page
     * @returns {Promise<void>}
     */
    async modifyBrowserContext(page) {

        const params = {
            connection: this.currentUserAgent.data.connection,
            platform: this.currentUserAgent.data.platform,
            outerWidth: this.currentUserAgent.data.viewportWidth,
            outerHeight: this.currentUserAgent.data.viewportHeight,
            chrome: {
                loadTimes: {},
                csi: {},
                app: {
                    isInstalled: true,
                    getDetails: {},
                    getIsInstalled: {},
                    installState: {},
                    runningState: {},
                    InstallState: {},
                    RunningState: {},
                },
            },
        };

        await page.evaluateOnNewDocument((params) => {

            Object.defineProperty(navigator, 'connection', {
                get: function () {
                    return params.connection;
                }
            });

            Object.defineProperty(navigator, 'platform', {
                get: function () {
                    return params.platform;
                }
            });

            Object.defineProperty(window, 'outerWidth', {
                get: function () {
                    return params.outerWidth;
                }
            });

            Object.defineProperty(window, 'outerHeight', {
                get: function () {
                    return params.outerHeight;
                }
            });

            if (params.chrome) {
                Object.defineProperty(window, 'chrome', {
                    get: function () {
                        return params.chrome;
                    },
                });
            }

        }, params);
    }

    /**
     * Method save current page cookies to file
     * @param path
     * @returns {Promise<void>}
     */
    async saveCookies(path) {
        const cookies = await this.page.cookies();
        fs.writeFileSync(path, JSON.stringify(cookies, null, 2));
    }

    /**
     * Method load cookies from file to current page
     * @param path
     * @returns {Promise<void>}
     */
    async loadCookies(path) {
        const cookiesRaw = fs.readFileSync(path);
        const cookies = JSON.parse(cookiesRaw);
        await this.page.setCookie(...cookies);
    }
}