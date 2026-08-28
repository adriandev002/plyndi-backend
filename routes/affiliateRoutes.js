const express = require('express');
const geoDetect = require('../middleware/geoDetect');
const { getAffiliateRecommendations } = require('../controllers/affiliateController');

const router = express.Router();
router.get('/affiliates', geoDetect, getAffiliateRecommendations);

module.exports = router;
