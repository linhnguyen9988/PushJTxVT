const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        const name = (req.app_user || 'guest') + '-' + Date.now() + path.extname(file.originalname);
        cb(null, name);
    }
});

const upload = multer({ storage: storage });

module.exports = { upload };
