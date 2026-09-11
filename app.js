const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');
const urjaClient = require('./services/urjaClient');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Load OpenAPI specification
const openapiSpec = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8')
);

app.use(express.json());

// 1. Mount Interactive Swagger Documentation (Excluded from auth middleware)
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

// 2. Authentication Middleware
app.use(async (req, res, next) => {
    try {
        await urjaClient.ensureAuthenticated();
        next();
    } catch (error) {
        res.status(502).json({ error: "Failed to establish session with Urja Portal." });
    }
});

// 3. API Routes
app.get('/api/v1/meters', async (req, res) => {
    try {
        const meters = await urjaClient.getAllMeters();
        res.json(meters);
    } catch (error) {
        res.status(502).json({ error: "Bad Gateway: Legacy portal failed to respond." });
    }
});

app.get('/api/v1/meters/:id', async (req, res) => {
    try {
        const meterId = req.params.id;
        const details = await urjaClient.getMeterDetails(meterId);
        res.json(details);
    } catch (error) {
        const status = error.status || 502;
        res.status(status).json({ error: error.message });
    }
});

app.get('/api/v1/meters/:id/energy', async (req, res) => {
    try {
        const meterId = req.params.id;
        const energy = await urjaClient.getEnergy(meterId);
        res.json(energy);
    } catch (error) {
        res.status(502).json({ error: `Failed to fetch energy data for meter ${req.params.id}` });
    }
});

app.get('/api/v1/network/hierarchy', async (req, res) => {
    try {
        const hierarchy = await urjaClient.getNetworkHierarchy();
        res.json(hierarchy);
    } catch (error) {
        res.status(502).json({ error: "Failed to assemble network hierarchy from legacy portal." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Flock API Wrapper running on http://localhost:${PORT}`);
    console.log(`📖 Interactive API Docs available at http://localhost:${PORT}/docs`);
    console.log(`Try accessing: http://localhost:${PORT}/api/v1/meters`);
});