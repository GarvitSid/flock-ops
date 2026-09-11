const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const jar = new CookieJar();

const client = wrapper(axios.create({
    baseURL: 'https://urja-ops.flockenergy.tech',
    jar,
    withCredentials: true,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
}));

let isAuthenticated = false;
let loginPromise = null;


const urjaClient = {
    async ensureAuthenticated() {
        if (isAuthenticated) return;

        // Prevent race conditions: reuse in-flight login promise if multiple requests hit simultaneously
        if (!loginPromise) {
            loginPromise = (async () => {
                try {
                    await urjaClient.login(process.env.URJA_EMAIL, process.env.URJA_PASSWORD);
                    isAuthenticated = true;
                } finally {
                    loginPromise = null;
                }
            })();
        }
        return loginPromise;
    },
    async login(email, password) {
        try {
            const payload = new URLSearchParams({ email, password });

            const response = await client.post('/login', payload, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'x-sveltekit-action': 'true',
                    'Origin': 'https://urja-ops.flockenergy.tech',
                    'Referer': 'https://urja-ops.flockenergy.tech/login',
                    'Accept': 'application/json'
                }
            });

            const cookies = await jar.getCookies('https://urja-ops.flockenergy.tech');
            const authCookie = cookies.find(c => c.key === '__Secure-better-auth.session_token');

            if (!authCookie) {
                throw new Error("Failed to retrieve session cookie from portal.");
            }
            console.log("✅ Successfully logged in and stored session cookie!");
            return true;
        } catch (error) {
            console.error("❌ Login failed:", error.message);
            throw new Error("Authentication failed");
        }
    },

    async getAllMeters() {
        try {
            console.log("Fetching page 1 to determine total pages...");
            const firstPageResponse = await client.get('/portal/meters/search?q=&page=1');
            const initialData = firstPageResponse.data;

            const totalRecords = initialData.total;
            const pageSize = initialData.pageSize;
            const totalPages = Math.ceil(totalRecords / pageSize);

            let allMeters = [...initialData.data];
            console.log(`Found ${totalRecords} total meters. Fetching remaining ${totalPages - 1} pages...`);

            for (let page = 2; page <= totalPages; page++) {
                const response = await client.get(`/portal/meters/search?q=&page=${page}`);
                allMeters.push(...response.data.data);
            }

            console.log(`Successfully aggregated all ${allMeters.length} meters!`);

            return {
                total: allMeters.length,
                data: allMeters
            };
        } catch (error) {
            console.error("Failed to fetch all meters:", error.message);
            throw error;
        }
    },

    async getEnergy(meterId) {
        try {
            const response = await client.get(`/portal/meters/${meterId}/energy`);
            return response.data;
        } catch (error) {
            console.error(`Failed to fetch energy for ${meterId}:`, error.message);
            throw error;
        }
    },

    async getMeterDetails(meterId) {
        try {
            const [htmlResponse, geoResponse] = await Promise.all([
                client.get(`/meters/${meterId}`),
                client.get(`/portal/meters/${meterId}/geo`).catch(() => ({ data: {} }))
            ]);

            const $ = cheerio.load(htmlResponse.data);

            const geoData = geoResponse.data.data || {};
            const latitude = geoData.latitude || null;
            const longitude = geoData.longitude || null;

            const nameplate = {};
            $('dt').each((_, el) => {
                // Remove all whitespace, colons, and non-alphanumeric chars, then lowercase
                const rawKey = $(el).text().replace(/\s+|:/g, '').toLowerCase();
                const rawVal = $(el).parent().find('dd').text().trim();
                nameplate[rawKey] = rawVal || null;
            });

            const data = {
                meterId: nameplate['meterid'] || meterId,
                serialNo: nameplate['serialno'] || null,
                make: nameplate['make'] || null,
                phaseType: nameplate['phasetype'] || null,
                installStatus: nameplate['installationstatus'] || null,
                installType: nameplate['installationtype'] || null,
                location: {
                    latitude: latitude,
                    longitude: longitude
                }
            };

            return data;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                const notFound = new Error("Meter not found");
                notFound.status = 404;
                throw notFound;
            }
            throw error;
        }
    },

    async getNetworkHierarchy() {
        try {
            // 1. Fetch all 40 transformers across the 2 known pages
            const [dtsPage1, dtsPage2, metersResult] = await Promise.all([
                client.get('/portal/dts?page=1'),
                client.get('/portal/dts?page=2'),
                this.getAllMeters()
            ]);

            const transformers = [...dtsPage1.data.data, ...dtsPage2.data.data];
            const meters = metersResult.data;

            // 2. Group meters by their DT Code
            const metersByDt = {};
            for (const meter of meters) {
                const dt = meter.dtCode || 'UNASSIGNED';
                if (!metersByDt[dt]) {
                    metersByDt[dt] = [];
                }
                metersByDt[dt].push({
                    meterId: meter.meterId,
                    serialNo: meter.serialNo,
                    status: meter.installStatus,
                    phase: meter.phaseType
                });
            }

            // 3. Group transformers under their parent Feeder
            const feedersMap = {};

            for (const dt of transformers) {
                const feeder = dt.feederCode || 'UNASSIGNED';
                if (!feedersMap[feeder]) {
                    feedersMap[feeder] = {
                        feederCode: feeder,
                        transformers: []
                    };
                }

                feedersMap[feeder].transformers.push({
                    transformerCode: dt.code,
                    name: dt.name,
                    capacityKva: dt.capacityKva,
                    meterCount: (metersByDt[dt.code] || []).length,
                    meters: metersByDt[dt.code] || []
                });
            }

            return Object.values(feedersMap);
        } catch (error) {
            console.error("Failed to build network hierarchy:", error.message);
            throw error;
        }
    }
};



module.exports = urjaClient;