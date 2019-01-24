const fs = require('fs');
const path = require('path');
const {createCanvas, Image} = require('canvas');
const blockchain = require('./blockchain.js');
const ipfsWrapper = require('./ipfs.js');
const Base64 = require('js-base64').Base64;
const storage = require('./storage.js');
const svgUtil = require('./svg_util.js');

const canvas = {};


const renderInterval = 20000;

const canvasCentimeterWidth = 33 * 100;
const canvasCentimeterHeight = 50 * 100;
const pixelsPerCentimeter = 1;
const width = canvasCentimeterWidth * pixelsPerCentimeter;
const height = canvasCentimeterHeight * pixelsPerCentimeter;

let current_height = 0;

intervalJob = async () => {
    current_height = await blockchain.height().catch(console.error);
    console.log('intervalJob', current_height);
    await canvas.render();
};

canvas.init = async () => {
    await blockchain.init();
    await intervalJob();

    // use timeout until we have a listener function for new blocks from the sdk
    setInterval(intervalJob, renderInterval);
};

canvas.pathLatest = "../rendered/latest.png";
canvas.pathByHeight = () => {
    return `../rendered/height/${current_height}.png`;
};

canvas.mergeImages = async (sources) => {

    // Load sources
    const images = sources.map(source => new Promise((resolve, reject) => {
        // Resolve source and image when loaded
        const image = new Image();
        image.onerror = () => reject(new Error('Couldn\'t load image'));
        image.onload = () => resolve(Object.assign({}, source, {img: image}));
        image.src = source.src;
    }).catch(console.error));

    // create canvas context
    const tempCanvas = createCanvas(width, height);
    const canvasContext = tempCanvas.getContext('2d');

    // set background color similar to wall
    canvasContext.fillStyle = "#FFFABA";
    canvasContext.fillRect(0, 0, width, height);

    const loadedImages = await Promise.all(images);

    // draw images to canvas
    loadedImages.forEach(image => {
        if (image) {
            canvasContext.globalAlpha = image.opacity ? image.opacity : 1;
            if (image.width > 0 && image.height > 0) {
                canvasContext.drawImage(image.img, image.x || 0, image.y || 0, image.width, image.height);
            } else {
                canvasContext.drawImage(image.img, image.x || 0, image.y || 0);
            }
        }
    });

    return tempCanvas.toBuffer('image/png');
};

canvas.render = async () => {

    // get all files from ipfs that were included in bids
    const auctionSlots = await blockchain.auctionSlots().catch(console.error);
    const successfulBids = auctionSlots
        .sort((a, b) => a.endBlockHeight - b.endBlockHeight) // sort slots ascending by end block height
        .map(slot => slot.successfulBids.sort((a, b) => a.seqId - b.seqId)) // sort bids in slot ascending
        .reduce((acc, val) => acc.concat(val), []); // flatten inner arrays

    // backup data
    Promise.all(successfulBids
        .map(async bid => await storage.backupBid(bid.data.artworkReference, bid)))
        .catch((e) => console.warn('bid upload failed', e.message));

    // fetching files from ipfs
    const ipfsSources = await Promise.all(successfulBids.map(bid => {
        return ipfsWrapper.getFile(bid.data.artworkReference).then(filebuffer => {
            return {filebuffer: filebuffer, bid: bid};
        }).catch(console.error);
    }));

    // filter files unable to be fetched and failing sanity checks, map to base64 encoding with coordinates included
    const transformedSources = await Promise.all(ipfsSources
        .filter(data => !!data.filebuffer)
        .filter(data => svgUtil.sanityCheck(data).checkPassed)
        .map(async data => {
            const {width, height, svg} = svgUtil.getSVGDimensions(data.filebuffer.toString('utf8'));
            if (!svg) return console.error('Could not get width and height from svg ' + data.bid.data.artworkReference);

            storage.backupSVG(data.bid.data.artworkReference, svg).catch((e) => {
                console.warn('svg upload failed');
                console.warn(e.message);
            });

            return {
                src: 'data:image/svg+xml;base64,' + Base64.encode(svg),
                x: data.bid.data.coordinates.x * pixelsPerCentimeter,
                y: data.bid.data.coordinates.y * pixelsPerCentimeter,
                width,
                height
            };
        }));

    const buffer = await canvas.mergeImages(transformedSources);
    fs.writeFileSync(path.join(__dirname, canvas.pathByHeight()), buffer);
    fs.writeFileSync(path.join(__dirname, canvas.pathLatest), buffer);
    console.log('did merge and write', transformedSources.length);
};

module.exports = canvas;