const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const axios = require('axios');
var CryptoJS = require("crypto-js");
const ExcelJS = require('exceljs');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require("socket.io");

const JWT_SECRET = process.env.JWT_SECRET || 'tvship_jwt_secret_key_change_in_production_2024!';
const JWT_EXPIRES_IN = '30d';

const STATUS_MAP = {
    pending: { text: 'Chờ lấy hàng', class: 'bg-warning-subtle text-warning-emphasis border border-warning' },
    cancel: { text: 'Đã hủy đơn', class: 'bg-secondary-subtle text-secondary border border-secondary' },
    picked_up: { text: 'Đã lấy hàng', class: 'bg-info-subtle text-info-emphasis border border-info' },
    delivering: { text: 'Đang vận chuyển', class: 'bg-primary-subtle text-primary border border-primary' },
    out_for_delivery: { text: 'Đang giao hàng', class: 'bg-primary border text-white' },
    completed: { text: 'Thành công', class: 'bg-success-subtle text-success border border-success' },
    returning: { text: 'Đang hoàn', class: 'bg-danger-subtle text-danger border border-danger' },
    returned: { text: 'Đã hoàn hàng', class: 'bg-dark-subtle text-dark border border-dark' },
    issue: { text: 'Kiện vấn đề', class: 'bg-danger text-white border border-danger' }
};

function getBadge(status) {
    const s = status ? status.toLowerCase() : '';
    return STATUS_MAP[s] || { text: status || 'N/A', class: 'bg-light text-dark border' };
}

const app = express();
const options = {
    key: fs.readFileSync('c:\\tvship.vn-key.pem'),
    cert: fs.readFileSync('c:\\tvship.vn-chain.pem')
};
const httpServer = http.createServer(app);
const httpsServer = https.createServer(options, app);

const io = new Server(httpsServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e7 // 10MB — đủ cho 1 batch 10 tem (~800KB thực tế)
});

io.on("connection", (socket) => {
    console.log("Thiết bị kết nối:", socket.id);

    socket.on("login-printer", (credentials) => {
        const { username, password } = credentials;

        db.query(
            'SELECT id, password FROM users WHERE username = ? LIMIT 1',
            [username],
            async (err, results) => {
                if (err) return socket.emit("login-error", "Lỗi DB");

                if (results.length > 0) {
                    const user = results[0];
                    const match = await bcrypt.compare(password, user.password);

                    if (match) {
                        const userRoom = `USER_ROOM_${user.id}`;

                        // Kick tất cả socket cũ ra khỏi room trước khi join
                        // Tránh trường hợp App C# reconnect → 2 socket cùng room → in 2 lần
                        const existingRoom = io.sockets.adapter.rooms.get(userRoom);
                        if (existingRoom) {
                            for (const oldSocketId of existingRoom) {
                                if (oldSocketId !== socket.id) {
                                    const oldSocket = io.sockets.sockets.get(oldSocketId);
                                    if (oldSocket) {
                                        oldSocket.leave(userRoom);
                                        console.log(`[Socket] Kicked old socket ${oldSocketId} from ${userRoom}`);
                                    }
                                }
                            }
                        }

                        socket.join(userRoom);
                        socket.emit("login-success", { message: "Thành công", userRoom });
                    } else {
                        socket.emit("login-error", "Sai mật khẩu!");
                    }
                } else {
                    socket.emit("login-error", "Tài khoản không tồn tại!");
                }
            }
        );
    });

    socket.on("logout-printer", ({ username }) => {
        // App C# gọi khi đổi tài khoản — rời toàn bộ room USER_ROOM_*
        for (const room of socket.rooms) {
            if (room.startsWith("USER_ROOM_")) {
                socket.leave(room);
                console.log(`[Socket] ${username} rời room ${room}`);
            }
        }
    });

    socket.on("disconnect", (reason) => {
        console.log(`[Socket] Ngắt kết nối: ${socket.id} — lý do: ${reason}`);
        // Log room nào còn client sau khi disconnect để debug
        for (const room of socket.rooms) {
            if (room.startsWith("USER_ROOM_")) {
                const size = io.sockets.adapter.rooms.get(room)?.size ?? 0;
                console.log(`[Socket] Room ${room} còn ${size} client`);
            }
        }
    });
});

app.use((req, res, next) => {
    if (!req.secure) {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'halwhtihle',
    database: 'pushorder',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

db.getConnection((err, connection) => {
    if (err) console.error('Lỗi kết nối MySQL Pool:', err);
    else {
        connection.release();
    }
});


app.set('view engine', 'ejs');
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
// Guard: đảm bảo req.body không bao giờ undefined với POST/PUT/PATCH
app.use((req, res, next) => { if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.body) req.body = {}; next(); });
app.use(express.static('public'));
app.use(cookieParser());
app.use(session({
    secret: 'halwhtihle123!@#',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 10 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    }
}));
app.use(flash());
const cors = require('cors');
app.use(cors());

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        const name = (req.app_user || 'guest') + '-' + Date.now() + path.extname(file.originalname);
        cb(null, name);
    }
});
const upload = multer({ storage: storage });

app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');

    const token = req.cookies && req.cookies.jwt_token;
    if (token) {
        const decoded = verifyJWT(token);
        if (decoded) {
            db.query('SELECT avatar FROM users WHERE username = ?', [decoded.username], (err, results) => {
                if (err) return next();
                res.locals.user = decoded.username;
                res.locals.role = decoded.role;
                res.locals.avatar = (results && results.length > 0 && results[0].avatar) ? results[0].avatar : '/default-avatar.png';
                next();
            });
            return;
        }
    }

    res.locals.user = undefined;
    res.locals.role = undefined;
    res.locals.avatar = undefined;
    next();
});

function createLog(action, user) {
    console.log(`[LOG SYSTEM]: ${user} - ${action}`);

    db.query('INSERT INTO logs (action, performed_by) VALUES (?, ?)', [action, user || 'Hệ thống'], (err) => {
        if (err) {
            console.error("LỖI SQL KHI GHI LOG:", err.message);
        }
    });
}

const verifyJWT = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
};

const isAuth = (req, res, next) => {
    const tokenFromCookie = req.cookies && req.cookies.jwt_token;
    const authHeader = req.headers['authorization'];
    const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const token = tokenFromCookie || tokenFromHeader;

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded && decoded.username) {
                req.app_user = decoded.username;
                req.app_role = decoded.role;
                return next();
            }
        } catch (e) {
            if (e.name === 'TokenExpiredError') {
                res.clearCookie('jwt_token');
                if (req.xhr || req.path.startsWith('/api/')) {
                    return res.status(401).json({ success: false, message: 'Token đã hết hạn, vui lòng đăng nhập lại!' });
                }
                req.flash('error_msg', 'Phiên làm việc đã hết hạn, vui lòng đăng nhập lại.');
                return res.redirect('/login');
            }
            console.error('Lỗi xác thực token:', e.message);
        }
    }

    if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Hết phiên làm việc, vui lòng đăng nhập lại!' });
    }

    req.flash('error_msg', 'Vui lòng đăng nhập để tiếp tục.');
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.app_role === 'admin') return next();
    req.flash('error_msg', 'Bạn không có quyền quản trị.');
    res.redirect('/orders');
};

const isManager = (req, res, next) => {
    if (req.app_role === 'manager' || req.app_role === 'admin') return next();
    req.flash('error_msg', 'Bạn không có quyền thực hiện thao tác này.');
    res.redirect('/orders');
};

const redirectIfLoggedIn = (req, res, next) => {
    const token = req.cookies && req.cookies.jwt_token;
    if (token) {
        const decoded = verifyJWT(token);
        if (decoded) {
            return res.redirect(decoded.role === 'admin' ? '/admin/dashboard' : '/orders');
        }
    }
    next();
};

app.get('/', (req, res) => res.redirect('/login'));

app.get('/register', redirectIfLoggedIn, (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
    const { username, shopname, password } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, shopname, password, role) VALUES (?, ?, ?, "user")', [username, shopname, hashed], (err) => {
            if (err) {
                req.flash('error_msg', 'Tên đăng nhập đã tồn tại.');
                return res.redirect('/register');
            }
            res.redirect('/login');
        });
    } catch (e) { res.redirect('/register'); }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Chưa nhập tên tài khoản hoặc mật khẩu!' });
    }

    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Lỗi cơ sở dữ liệu' });

        if (results && results.length > 0) {
            const userRecord = results[0];

            if (userRecord.is_locked) {
                return res.status(403).json({ success: false, message: 'Tài khoản này đã bị khóa!' });
            }

            const match = await bcrypt.compare(password, userRecord.password);
            if (match) {
                const payload = {
                    username: userRecord.username,
                    role: userRecord.role,
                    userId: userRecord.id
                };
                const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

                createLog('Đã đăng nhập qua App Mobile', userRecord.username);
                return res.json({
                    success: true,
                    message: 'Đăng nhập thành công',
                    token: token,
                    expires_in: '30d',
                    user: {
                        username: userRecord.username,
                        role: userRecord.role
                    }
                });
            }
        }

        return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu!' });
    });
});

app.get('/api/profile', isAuth, (req, res) => {
    const username = req.app_user;

    const sql = `SELECT * FROM users WHERE username = ?`;

    db.query(sql, [username], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "Lỗi DB" });
        if (results.length === 0) return res.status(404).json({ success: false, message: "Không tìm thấy user" });

        res.json({ success: true, data: results[0] });
    });
});

app.get('/login', redirectIfLoggedIn, (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    const { username, password, rememberMe } = req.body;
    if (!username || !password) {
        req.flash('error_msg', 'Chưa nhập tên tài khoản hoặc mật khẩu!');
        return res.redirect('/login');
    }
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.redirect('/login');
        if (results && results.length > 0) {
            const userRecord = results[0];
            if (userRecord.is_locked) {
                req.flash('error_msg', 'Tài khoản này đã bị khóa!');
                return res.redirect('/login');
            }
            const match = await bcrypt.compare(password, userRecord.password);
            if (match) {
                const payload = {
                    username: userRecord.username,
                    role: userRecord.role,
                    userId: userRecord.id
                };
                const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

                // Lưu JWT vào cookie — hạn 30 ngày
                res.cookie('jwt_token', token, {
                    httpOnly: true,
                    secure: true,
                    sameSite: 'lax',
                    maxAge: 30 * 24 * 60 * 60 * 1000
                });

                createLog('Đã đăng nhập vào hệ thống', userRecord.username);
                return res.redirect(userRecord.role === 'admin' ? '/admin/dashboard' : '/orders');
            }
        }
        req.flash('error_msg', 'Sai tài khoản hoặc mật khẩu!');
        res.redirect('/login');
    });
});
app.post('/ghn', function (req, res) {
    console.log(req.body)
    res.sendStatus(200);
});

app.post('/jtex', function (req, res) {
    res.json({ "code": "1", "msg": "success", "data": null });

    try {
        const { bizContent } = req.body;
        if (!bizContent) return;

        const data = JSON.parse(bizContent);
        const billCode = data.billCode;
        const details = data.details[0];
        //console.log('nhan wh: '+billCode) //lau lau no ko nhan dc webhook vi chay node app.js chua hieu tai sao
        const statusMapVn = {
            103: "Tạo đơn thành công",
            105: "Đã hủy đơn",
            106: "Bưu tá đã lấy hàng",
            109: "Xuất kho trung chuyển",
            110: "Hàng đã đến bưu cục",
            112: "Đang giao hàng",
            113: "Giao hàng thành công",
            116: "Đang chuyển hoàn",
            117: "Đã ký nhận hoàn trả",
            118: "Kiện vấn đề (Giao)",
            120: "Kiện vấn đề (Hoàn)"
        };
        let currentTypeName = statusMapVn[details.scanTypeCode] || details.scanTypeName || "Hành trình mới";
        if (currentTypeName == '中心到件') currentTypeName = 'Hàng đến kho TTKT';
        else if (currentTypeName == '取件失败') currentTypeName = 'Nhận hàng không thành công';

        let scanbyphone = details.scanByContact;
        if (scanbyphone) scanbyphone = scanbyphone.replace("+84", "0");

        const waybillParams = [
            billCode,
            details.scanByCode || null,
            scanbyphone || null,
            details.scanByName || null,
            details.scanNetworkArea || null,
            details.scanNetworkCity || null,
            details.scanNetworkProvince || null,
            details.scanNetworkName || null,
            details.scanTime,
            currentTypeName,
            details.abnormalPieceName || null
        ];

        const sqlInsertWaybill = `INSERT INTO jtwaybill
            (billcode, scanbycode, scanbycontact, scanbyname, scanward, scancity, scanprov, scanpost, scantime, scantypename, issuename)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

        db.query(sqlInsertWaybill, waybillParams, (err) => {
            if (err) console.error('[Webhook J&T] Lỗi INSERT jtwaybill:', err);
        });

        const scanCode = Number(details.scanTypeCode);
        let updateSql = "";
        let params = [];

        switch (scanCode) {
            case 103:
                updateSql = "UPDATE orders SET status = 'pending' WHERE realjtbillcode =?";
                params = [billCode];
                break;

            case 105:
                updateSql = "UPDATE orders SET status = 'cancel' WHERE realjtbillcode =?";
                params = [billCode];
                break;

            case 106:
                updateSql = "UPDATE orders SET status = 'picked_up', pickup_date = NOW() WHERE realjtbillcode =?";
                params = [billCode];
                //updateSql = "UPDATE orders SET status = 'picked_up', weight =?, pickup_date = NOW() WHERE realjtbillcode =?";
                //params = [details.weight || 0, billCode];
                break;

            case 109:
            case 110:
                updateSql = `UPDATE orders
                    SET status = 'delivering', issue = null,
                        pickup_date = COALESCE(pickup_date, NOW())
                    WHERE realjtbillcode =? AND status NOT IN ('completed', 'cancel', 'returned')`;
                params = [billCode];
                break;

            case 112:
                updateSql = `UPDATE orders
                    SET status = 'out_for_delivery', issue = null WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 113:
                updateSql = `UPDATE orders
                    SET status = 'completed', issue = null WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 116:
                updateSql = `UPDATE orders
                    SET status = 'returning', issue = null
                    WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 117:
                updateSql = `UPDATE orders
                    SET status = 'returned', issue = null
                    WHERE realjtbillcode =?`;
                params = [billCode];
                break;

            case 118:
            case 120:
                updateSql = `UPDATE orders
                    SET status = 'issue', issue =?
                    WHERE realjtbillcode =?`;
                params = [details.abnormalPieceName, billCode];
                break;

            default:
                //console.log(details.scanTypeName);
        }

        if (updateSql) {
            db.query(updateSql, params, (err, result) => {
                if (err) {
                    console.error('[Webhook J&T] Lỗi thực thi SQL:', err.message);
                } else if (result.affectedRows === 0) {
                    console.warn(`[Webhook J&T] KHÔNG TÌM THẤY đơn hàng. Bill: ${billCode}`);
                }
            });
        }

        if (scanCode >= 106 && scanCode !== 105) {
            db.query(
                "UPDATE orders SET pickup_date = COALESCE(pickup_date, NOW()) WHERE realjtbillcode =? AND pickup_date IS NULL",
                [billCode]
            );
        }

    } catch (error) {
        console.error('Lỗi Webhook J&T:', error);
    }
});

app.use(isAuth);//Chỉ có login và register nằm trước cái này

app.post('/admin/toggle-lock/:id', isManager, (req, res) => {
    db.query('UPDATE users SET is_locked = NOT is_locked WHERE id = ?', [req.params.id], (err) => {
        createLog(`Thay đổi trạng thái khóa User ID: ${req.params.id}`, req.app_user);
        res.redirect('/admin/dashboard');
    });
});

app.get('/profile', async (req, res) => {
    if (!req.app_user) return res.redirect('/login');

    const username = req.app_user;

    try {
        const sqlUser = `
            SELECT 
                u.*,
                (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as total_orders,
                (SELECT COUNT(*) FROM orders WHERE user_id = u.id AND status IN ('picked_up', 'delivering')) as shipping_orders,
                (SELECT SUM(price) FROM orders WHERE user_id = u.id AND status = 'completed') as total_revenue,
                (SELECT SUM(weight) FROM orders WHERE user_id = u.id AND status = 'completed') as total_weight
            FROM users u 
            WHERE u.username = ?`;

        const [userResults] = await db.promise().query(sqlUser, [username]);

        if (!userResults || userResults.length === 0) {
            return res.redirect('/login');
        }

        const userData = userResults[0];

        const sqlNotes = `SELECT * FROM order_notes WHERE user_id = ? ORDER BY created_at DESC`;
        const sqlProducts = `SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC`;

        const [[notes], [products]] = await Promise.all([
            db.promise().query(sqlNotes, [userData.id]),
            db.promise().query(sqlProducts, [userData.id])
        ]);

        res.render('profile', {
            user: userData.username,
            role: userData.role,
            avatar: userData.avatar,
            stats: userData,
            vtp_inventory_id: userData.vtp_inventory_id,
            vtp_shop_name: userData.vtp_shop_name,
            vtp_shop_phone: userData.vtp_shop_phone,
            vtp_shop_address: userData.vtp_shop_address,
            jt_sdt: userData.jt_sdt,
            jt_shopname: userData.jt_shopname,
            jt_shopaddress: userData.jt_shopaddress,
            jt_shop_ward: userData.jt_shop_ward,
            jt_shop_district: userData.jt_shop_district,
            jt_shop_prov: userData.jt_shop_prov,
            notes: notes || [],
            products: products || [],
            show_cod: userData.show_cod !== undefined ? userData.show_cod : 1,
            use_socket_print: userData.use_socket_print !== undefined ? userData.use_socket_print : 0,
            active: 'profile'
        });

    } catch (error) {
        console.error("Lỗi hệ thống tại route /profile:", error);
        res.status(500).send("Đã có lỗi xảy ra.");
    }
});

app.post('/profile/upload-avatar', isAuth, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.redirect('/profile');
    const path = '/uploads/' + req.file.filename;
    db.query('UPDATE users SET avatar = ? WHERE username = ?', [path, req.app_user], (err) => {
        res.redirect('/profile');
    });
});

app.post('/profile/change-password', isAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) {
        req.flash('error_msg', 'Mật khẩu mới không khớp.');
        return res.redirect('/profile');
    }
    db.query('SELECT password FROM users WHERE username = ?', [req.app_user], async (err, results) => {
        const match = await bcrypt.compare(oldPassword, results[0].password);
        if (!match) {
            req.flash('error_msg', 'Mật khẩu cũ không đúng.');
            return res.redirect('/profile');
        }
        const hashed = await bcrypt.hash(newPassword, 10);
        db.query('UPDATE users SET password = ? WHERE username = ?', [hashed, req.app_user], (err) => {
            req.flash('success_msg', 'Đổi mật khẩu thành công.');
            res.redirect('/profile');
        });
    });
});

app.post('/api/change-password', isAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const username = req.app_user;

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Mật khẩu mới không khớp.' });
    }

    try {
        const [rows] = await db.promise().query('SELECT password FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'User không tồn tại.' });

        const match = await bcrypt.compare(oldPassword, rows[0].password);
        if (!match) {
            return res.status(400).json({ success: false, message: 'Mật khẩu cũ không đúng.' });
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        await db.promise().query('UPDATE users SET password = ? WHERE username = ?', [hashed, username]);

        res.json({ success: true, message: 'Đổi mật khẩu thành công.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi hệ thống.' });
    }
});

app.get('/admin/dashboard', isManager, async (req, res) => {
    const search = req.query.search || '';
    const currentUser = req.app_user;

    try {
        const [usersRows, statsRows, logsRows, vtpRows, todayStatsRows] = await Promise.all([
            db.promise().query(
                "SELECT * FROM users WHERE username LIKE ? AND username != ?",
                [`%${search}%`, currentUser]
            ),
            db.promise().query("SELECT role, COUNT(*) as count FROM users GROUP BY role"),
            db.promise().query("SELECT * FROM logs ORDER BY created_at DESC LIMIT 10"),
            db.promise().query("SELECT * FROM viettel_connect WHERE id = 1"),
            db.promise().query(`
                SELECT 
                    u.shopname, 
                    u.username, 
                    COUNT(o.id) as total_orders,
                    SUM(o.price) as total_cod
                FROM orders o
                JOIN users u ON o.user_id = u.id
                WHERE o.created_at >= NOW() - INTERVAL 72 HOUR AND o.status='pending'
                GROUP BY u.id
                ORDER BY total_orders DESC
            `)
        ]);

        res.render('admin_dashboard', {
            users: usersRows[0],
            stats: statsRows[0],
            logs: logsRows[0],
            search: search,
            vtpConfig: vtpRows[0][0] || null,
            todayStats: todayStatsRows[0],
            currentRole: req.app_role,
            active: 'admin_dashboard'
        });

    } catch (err) {
        console.error("Lỗi Dashboard:", err.message);
        res.status(500).send("Lỗi hệ thống khi tải Dashboard");
    }
});



app.post('/admin/delete/:id', isAdmin, async (req, res) => {
    const targetId = req.params.id;
    const adminUsername = req.app_user;

    try {
        const [adminRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [adminUsername]);
        if (adminRows.length > 0 && adminRows[0].id == targetId) {
            return res.status(400).send("Không thể tự xóa chính mình!");
        }

        await db.promise().query('DELETE FROM users WHERE id = ?', [targetId]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi khi xóa người dùng");
    }
});

app.post('/admin/change-role/:id', isAdmin, async (req, res) => {
    const { newRole } = req.body;
    const targetId = req.params.id;

    try {
        await db.promise().query('UPDATE users SET role = ? WHERE id = ?', [newRole, targetId]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi khi cập nhật quyền");
    }
});

app.get('/admin/export-excel', isManager, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Users');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Username', key: 'username', width: 30 },
            { header: 'Role', key: 'role', width: 15 }
        ];

        const [results] = await db.promise().query('SELECT id, username, role FROM users');

        results.forEach(u => worksheet.addRow(u));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Users.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error("Lỗi xuất Excel:", err);
        res.status(500).send("Không thể xuất file lúc này");
    }
});
app.get('/api/customers', isAuth, async (req, res) => {
    const username = req.app_user;
    const search = req.query.search || '';

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    try {
        const [userRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [username]);
        if (userRows.length === 0) return res.status(401).json([]);
        const userId = userRows[0].id;

        let sql = `SELECT * FROM customers WHERE user_id = ?`;
        let params = [userId];

        if (search) {
            sql += ` AND (name LIKE ? OR phone LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [customers] = await db.promise().query(sql, params);

        res.json(customers);

    } catch (err) {
        console.error("Lỗi API Customers:", err);
        res.status(500).json([]);
    }
});
app.get('/customers', isAuth, async (req, res) => {
    const username = req.app_user;
    const search = req.query.search || '';

    try {
        const [userRows] = await db.promise().query(
            `SELECT id, vtp_shop_phone, vtp_shop_address, base_price, step_price, 
                    jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov 
             FROM users WHERE username = ?`,
            [username]
        );

        if (userRows.length === 0) return res.redirect('/login');

        const userData = userRows[0];
        const userId = userData.id;

        const stats = {
            vtp_shop_phone: userData.vtp_shop_phone || 'Chưa cấu hình',
            vtp_shop_address: userData.vtp_shop_address || 'Chưa cấu hình',
            base_price: userData.base_price || 0,
            step_price: userData.step_price || 0,
            jt_sdt: userData.jt_sdt || '',
            jt_shopname: userData.jt_shopname || '',
            jt_shopaddress: userData.jt_shopaddress || '',
            jt_shop_ward: userData.jt_shop_ward || '',
            jt_shop_district: userData.jt_shop_district || '',
            jt_shop_prov: userData.jt_shop_prov || ''
        };

        const [noteRows] = await db.promise().query(
            'SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        const [productRows] = await db.promise().query(
            'SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        let customersSql = `SELECT * FROM customers WHERE user_id = ?`;
        let params = [userId];

        if (search) {
            customersSql += ` AND (name LIKE ? OR phone LIKE ?) ORDER BY created_at DESC`;
            params.push(`%${search}%`, `%${search}%`);
        } else {
            customersSql += ` ORDER BY created_at DESC LIMIT 50`;
        }

        const [customers] = await db.promise().query(customersSql, params);

        res.render('customers', {
            user: username,
            customers: customers,
            search: search,
            isFiltering: !!search,
            stats: stats,
            notes: noteRows || [],
            products: productRows || [],
            active: 'customers'
        });
    } catch (err) {
        console.error("Lỗi trang khách hàng:", err);
        res.status(500).send("Lỗi hệ thống");
    }
});


function applyAddressFixes(sWard, sDist) {

    sWard = (sWard || '').toLowerCase().normalize('NFC').trim();
    sDist = (sDist || '').toLowerCase().normalize('NFC').trim();

    sWard = sWard.replace(/\s*-\s*(h\.|huyện|quận|tt|tx|thị trấn|trấn trấn|thị xã).*$/i, '').trim();

    if (sWard === 'trung nghĩa') sWard = 'yên trung';
    if (sWard === 'cần guộc') sWard = 'cần giuộc';
    if (sWard === 'eatling') sWard = 'ea tling';
    if (sDist === 'phú xuân') sDist = 'huế';
    if (sDist === 'gò vấp' && ['1', '3', '4', '5', '7'].includes(sWard)) sWard = '0' + sWard;
    if (sDist === 'bình giang' && sWard === 'thái minh') sWard = 'bình minh';
    if (sDist === 'nghĩa hưng' && sWard === 'đông thịnh') sWard = 'nghĩa Đồng';
    if (sDist === 'xuân trường' && sWard === 'xuân phúc') sWard = 'xuân hòa';
    if (sDist === 'quỳ châu' && sWard === 'quỳ châu') sWard = 'tân lạc';
    if (sDist === 'đạ huoai' && sWard === 'quốc oai') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'mỹ đức') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'đạ kho') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'đạ lây') sDist = 'đạ tẻh';
    if (sDist === 'long điền' && sWard === 'tam an') sWard = 'an ngãi';
    if (sWard === 'đạ tẻh' && sDist === 'đạ huoai') sDist = 'đạ tẻh';
    if (sDist === 'đạ huoai' && sWard === 'quảng ngãi') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'phước cát') sDist = 'cát tiên';
    if (sDist === 'đạ huoai' && sWard === 'cát tiên') sDist = 'cát tiên';
    if (sDist === 'phú lộc' && sWard === 'hương lộc') sDist = 'nam đông';
    if (sDist === 'giao thủy' && sWard === 'giao thủy') sWard = 'ngô đồng';
    if (sDist === 'cẩm giàng' && sWard === 'phúc điền') sWard = 'cẩm phúc';
    if (sDist === 'kim thành' && sWard === 'hòa bình') sWard = 'Liên Hòa';
    if (sDist === 'kim thành' && sWard === 'vũ dũng') sWard = 'cổ dũng';
    if (sDist === 'nam trực' && sWard === 'nam điền') sWard = 'nam mỹ';
    if (sDist === 'gia lộc' && sWard === 'quang đức') sWard = 'quang minh';
    if (sDist === 'nam sách' && sWard === 'an phú') sWard = 'an lâm';
    if (sDist === 'nam sách' && sWard === 'trần phú') sWard = 'nam trung';
    if (sDist === 'sơn dương' && sWard === 'hồng sơn') sWard = 'hồng lạc';
    if (sDist === 'cư mgar' && sWard === "cư m'ga") sWard = 'cư mgar';
    if (sDist === 'chũ' && sWard === 'chũ') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'thanh hải') sDist = 'lục ngạn';
    if (sDist === 'chũ' && sWard === 'hồng giang') sDist = 'lục ngạn';
    if (sDist === 'đạ huoai' && sWard === "đạp'loa") sWard = 'đoàn kết';
    if (sDist === 'bảo lâm' && sWard === 'lộc tlâm') sWard = 'lộc lâm';
    if (sDist === 'chũ' && sWard === 'phượng sơn') sDist = 'lục ngạn';
    if (sDist === 'phú lộc' && sWard === 'khe tre') sDist = 'nam đông';
    if (sDist === 'phú lộc' && sWard === 'thượng nhật') sDist = 'nam đông';
    if (sDist === 'cẩm phả' && sWard === 'hải hòa') sWard = 'cẩm hải';
    if (sDist === 'phú lộc' && sWard === 'hương phú') sDist = 'nam đông';
    if (sDist === 'nam định' && sWard === 'mỹ lộc') {sDist = 'mỹ lộc'; sWard = 'mỹ tiến';}
    if (sDist === 'xuân trường' && sWard === 'xuân giang') sWard = 'xuân đài';

    if (sDist.includes('chư') && sDist.includes('pưh')) sDist = 'chư pưh';
    if (sWard.includes('đồng sơn') && sDist.includes('đồng hới')) sWard = 'đồng sơn';
    if (sDist === 'long điền' && ['đất đỏ', 'láng dài', 'lộc an', 'long mỹ', 'long tân', 'phước long thọ', 'phước hải', 'phước hội'].includes(sWard)) {
        sDist = 'đất đỏ';
    }
    return { sWard, sDist };
}

function normalizeSQL(field) {
    const pairs = [
        ['đặ pék', 'đắk pék'], ['kong dỡng', 'kon dỡng'], ['kon chro', 'Kông Chro'], ['iakha', 'ia kha'],
        ['iii', '3'], ['ba', '3'], ['ii', '2'], ['i', '1'],
        ['krông ana', 'krông a na'], ['mdrăk', 'mđrăk'], ['cư drăm', 'cư đrăm'], ['ia sao', 'iasao'],
        ['đất đỏ', 'long đất'], ['long điền', 'long đất'],
        ['cần guộc', 'cần giuộc'], ['bàu hàm 1', 'bàu hàm'],
        ['hoà', 'hòa'], ['hoả', 'hỏa'], ['hoã', 'hỏa'], ['hoạ', 'họa'],
        ['oà', 'òa'], ['oả', 'ỏa'], ['oã', 'ỏa'], ['oạ', 'òa'],
        ['uý', 'úy'], ['uỳ', 'ùy'], ['uỷ', 'ủy'], ['uỹ', 'ũy'], ['uỵ', 'ụy'],
        ['thuý', 'thúy'], ['thuỷ', 'thủy'], ['thuỵ', 'thụy'],
        ['mĩ', 'mỹ'], ['kĩ', 'kỹ'], ['kì', 'kỳ'], ['kí', 'ký'], ['vĩ', 'vỹ'], ['hĩ', 'hỹ'], ['ngĩ', 'nghĩ'],
        ['quí', 'quý'], ['quì', 'quỳ'], ['quỉ', 'quỷ'], ['quĩ', 'quỹ'], ['quị', 'quỵ'],['qui', 'quy'],
        ['mí', 'mỹ'], ['hì', 'hỳ'], ['tí', 'tý'],
        ['sĩ', 'sỹ'], ['đông xá', 'Ðông Xá'], ['vân đồn', 'Vân Đồn'], ['10', 'mười']
    ];

    let sql = field;
    pairs.forEach(p => {
        sql = `REPLACE(${sql}, '${p[0]}', '${p[1]}')`;
    });
    return sql;
}

function cleanSearchTerm(str) {
    if (!str) return "";
    let cleaned = str.toLowerCase().normalize('NFC').trim();
    if (cleaned.length > 10 && cleaned.charAt(cleaned.length - 9) === '-') {
        cleaned = cleaned.slice(0, -9).trim();
    }
    return cleaned
        .replace(/(kcn|phường|xã|quận|huyện|thị xã|thị trấn|tt|tx|thành phố|thi xã|thi trấn|đảo|p.) (?!\d)/gi, "")
        .replace('trấn trấn', '')
        .replace('đường mười', 'Đường 10')
        .replace('p mông dương', 'mông dương')
        .replace('.', '')
        .replace('si phìn', 'si pa phìn')
        .replace(' (gia kiệm)', '')
        .replace('bà rịa - vũng tàu', 'bà rịa – vũng tàu')
        .replace('thừa thiên - huế', 'thừa thiên – huế')
        .replace("đăknhau", 'đăk nhau')
        .replace("đambri", 'Đạm Bri')
        .replace("ð", 'đ')
        .replace("cư niê", 'cư ni')
        .replace("h'leo", 'hleo')
        .replace("lai khê", 'lai vu')
        .replace("cẩm đông", 'Cẩm Ðông')
        .replace("bhinh", 'bhing')
        .replace("h'đing", 'hđinh')
        .replace("đăk ýa", 'Ðắk Ya')
        .replace("iale", 'ia le')
        .replace("đắk rtih", 'Đắk RTíh')
        .replace("sơ lang", 'sơn lang')
        .replace("n'thôn hạ", 'NThol Hạ')
        .replace("h'neng", 'hneng')
        .replace("ealy", 'ea ly')
        .replace("nậm pan", 'nậm ban')
        .replace("bát sát", 'bát xát')
        .replace("đăk môi", 'đăk môl')
        .replace("đưng k'nớh", 'đưng knớ')
        .replace("k'đơn", 'ka đơn')
        .replace("iasao", 'ia sao')
        .replace("nghãi", 'ngãi')
        .replace("- h chư pưh", '')
        .replace("iako", 'ia ko')
        .replace("iaka", 'ia ka')
        .replace("iarsươm", 'ia rsươm')
        .replace("cư dliê m'nông", 'Cư Dliê Mnông')
        .replace("iabăng", 'ia băng')
        .replace("iabang", 'ia bang')
        .replace("iadin", 'ia din')
        .replace("nà trì", 'nà chì')
        .replace("liêng s'rônh", 'Liêng Srônh')
        .replace("linh đông", 'Linh Ðông')
        .replace("đất quốc", 'đất cuốc')
        .replace("đăk r'moan", 'đăk rmoan')
        .replace("hà ra", 'hra')
        .replace("ia gar", 'ia ga')
        .replace("chà vài", 'chà vàl')
        .replace('iakring', 'ia kring')
        .replace('iakênh', 'ia kênh')
        .replace('chưhdrông', 'chư hdrông')
        .replace('iake', 'ia ake')
        .replace('iamơrơn', 'ia mrơn')
        .replace('nham biền', 'nham bền')
        .replace('eakao', 'ea kao')
        .replace('eapô', 'ea pô')
        .replace("h'nol", 'hnol')
        .replace("p quang hanh", 'quang hanh')
        .replace('thuận hóa', 'huế')
        .replace('cuebuor', 'xã cư êbur')
        .replace('chưr căm', 'chư rcăm')
        .replace('madaguoil', 'ma đa guôi')
        .replace('madagoil', 'ma đa guôi')
        .replace("đạm'ri", 'đạ mri')
        .replace('lâm ðồng', 'lâm đồng')
        .replace('bình ðịnh', 'bình định')
        .replace('krông pắk', 'krông pắc')
        .replace('ea kmêc', 'ea knuêc')
        .replace("ea m'nang", 'ea mnang')
        .replace("cư m'gar", 'cư mgar')
        .replace("m'đrắk", 'mdrăk')
        .replace("cư m'ta", 'cư mta')
        .replace("mỹ đình ii", 'mỹ đình 2')
        .replace("mỹ đình i", 'mỹ đình 1')
        .replace("an hoà", 'an hòa')
        .replace("đắk rô", 'đắk drô')
        .replace("eatu", 'ea tu')
        .replace("eatam", 'ea tam')
        .replace("cuôr dăng", 'cuôr đăng')
        .replace("long hoà", 'long hòa')
        .replace("an qui", 'an quy')
        .replace("long đất", 'long điền')
        .replace("nâm n jang", 'nâm njang')
        .replace("thuận hóa", 'huế')
        .replace("nam ðịnh", 'nam định')
        .replace("đliê ya", 'dliê ya')
        .replace("simacai", 'si ma cai')
        .replace("đà tẻh", 'đạ tẻh')
        .replace("pơngdrang", 'pơng drang')
        .replace("tông lệnh", 'tông lạnh')
        .replace("thứ 11", 'thứ mười một')
        .replace("tân hội cơ", 'tân hộ cơ')
        .replace("ia h'drai", 'ia hdrai')
        .trim();
}

app.post('/customers/edit', isAuth, async (req, res) => {
    const { id, name, phone, address } = req.body;
    const username = req.app_user;

    if (!name || !phone || !address) {
        return res.json({ success: false, message: "Tên, SĐT, địa chỉ không được để trống!" });
    }
    if (phone.length != 10) {
        return res.json({ success: false, message: "SĐT không hợp lệ!" });
    }

    try {
        const [tokenRows] = await db.promise().query(
            'SELECT vtp_token FROM viettel_connect WHERE id = 1 LIMIT 1'
        );

        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return res.json({ success: false, message: "Hệ thống chưa cấu hình Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, biên Hòa, Đồng Nai",
            "RECEIVER_ADDRESS": address,
            "PRODUCT_TYPE": "HH",
            "PRODUCT_WEIGHT": 100,
            "TYPE": 1
        }, {
            headers: { 'Content-Type': 'application/json', 'token': systemToken },
            timeout: 10000
        });

        const body = vtpRes.data;
        if (body.error == true || !body.RECEIVER_ADDRESS || !body.RECEIVER_ADDRESS.WARD_ID) {
            return res.json({ success: false, message: "Lỗi: Viettel không nhận diện được địa chỉ này" });
        }

        let tinh = "", huyen = "", xa = "";

        const [resTinh, resHuyen, resXa] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = resTinh.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = resHuyen.data.data?.DISTRICT_NAME || "";

        if (resXa.data.message?.includes('No suitable data found')) {
            return res.json({ success: false, message: "Lỗi: Thông tin phường xã đã bị Viettel thay đổi" });
        }
        xa = resXa.data.data?.WARDS_NAME || "";

        const sProv = cleanSearchTerm(tinh);
        let sDist = cleanSearchTerm(huyen);
        let sWard = cleanSearchTerm(xa);
        sWard = sWard.replace(/phường|xã/gi, "").trim();
        ({ sWard, sDist } = applyAddressFixes(sWard, sDist));

        console.log(`${sWard} - ${sDist} - ${sProv}`)

        const findJT = `
    SELECT * 
    FROM jtaddress
    WHERE 
        ${normalizeSQL('LOWER(prov)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND ${normalizeSQL('LOWER(district)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND (
            ${normalizeSQL('LOWER(ward)')} LIKE ${normalizeSQL('LOWER(?)')}
        )
    ORDER BY 
        (LOWER(ward) LIKE ?) DESC,
        (LOWER(district) = ?) DESC,
        LENGTH(ward) ASC
    LIMIT 1`;
        const [jtRows] = await db.promise().query(findJT, [
            `%${sProv}%`,
            `%${sDist}%`,
            `%${sWard}%`,
            `${sWard}%`,
            sDist
        ]);
        if (jtRows.length > 0) {
            const jt = jtRows[0];
            const sqlUpdate = `
                UPDATE customers 
                SET name = ?, phone = ?, address = ?, prov = ?, district = ?, ward = ?, newward = ?, newprov = ?  
                WHERE id = ?`;
            await db.promise().query(sqlUpdate, [name, phone, address, jt.prov, jt.district, jt.ward, jt.newward, jt.newprov, id]);

            createLog(`Sửa thông tin khách hàng: ${name}`, username);

            return res.json({
                success: true,
                tinh: jt.prov,
                huyen: jt.district,
                xa: jt.ward,
                newward: jt.newward,
                newprov: jt.newprov,
                message: `Đã sửa thông tin khách hàng ${name} thành công!`
            });
        } else {
            return res.json({
                success: false,
                message: `J&T không có dữ liệu cho địa chỉ: ${xa} - ${huyen} - ${tinh}.`
            });
        }

    } catch (error) {
        console.error("LỖI EDIT CUSTOMER:", error.message);
        return res.json({ success: false, message: "Lỗi hệ thống: " + error.message });
    }
});

app.post('/customers/add', isAuth, async (req, res) => {
    const { name, phone, address } = req.body;
    const username = req.app_user;

    if (!name || !phone || !address) {
        return res.json({ success: false, message: "Tên, SĐT, địa chỉ không được để trống!" });
    }
    if (phone.length != 10) {
        return res.json({ success: false, message: "SĐT phải đủ 10 số!" });
    }

    try {
        const [tokenRows] = await db.promise().query(
            'SELECT vtp_token FROM viettel_connect WHERE id = 1 LIMIT 1'
        );

        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return res.json({ success: false, message: "Hệ thống chưa cấu hình Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, biên Hòa, Đồng Nai",
            "RECEIVER_ADDRESS": address,
            "PRODUCT_TYPE": "HH",
            "PRODUCT_WEIGHT": 100,
            "TYPE": 1
        }, {
            headers: { 'Content-Type': 'application/json', 'token': systemToken },
            timeout: 10000
        });

        const body = vtpRes.data;
        if (body.error == true || !body.RECEIVER_ADDRESS || !body.RECEIVER_ADDRESS.WARD_ID) {
            return res.json({ success: false, message: "Lỗi: Không nhận diện được địa chỉ hoặc sai xã phường" });
        }

        let tinh = "", huyen = "", xa = "";

        const [resTinh, resHuyen, resXa] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = resTinh.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = resHuyen.data.data?.DISTRICT_NAME || "";

        if (resXa.data.message?.includes('No suitable data found')) {
            return res.json({ success: false, message: "Lỗi: Thông tin phường bị thay đổi, phải lên đơn tay" });
        }
        xa = resXa.data.data?.WARDS_NAME || "";

        const sProv = cleanSearchTerm(tinh);
        let sDist = cleanSearchTerm(huyen);
        let sWard = cleanSearchTerm(xa);
        sWard = sWard.replace(/phường|xã/gi, "").trim();
        ({ sWard, sDist } = applyAddressFixes(sWard, sDist));
        const findJT = `
    SELECT * 
    FROM jtaddress
    WHERE 
        ${normalizeSQL('LOWER(prov)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND ${normalizeSQL('LOWER(district)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND (
            ${normalizeSQL('LOWER(ward)')} LIKE ${normalizeSQL('LOWER(?)')}
        )
    ORDER BY 
        (LOWER(ward) LIKE ?) DESC,
        (LOWER(district) = ?) DESC,
        LENGTH(ward) ASC
    LIMIT 1`;

        const [jtRows] = await db.promise().query(findJT, [
            `%${sProv}%`,
            `%${sDist}%`,
            `%${sWard}%`,
            `${sWard}%`,
            sDist
        ]);

        if (jtRows.length > 0) {
            const jt = jtRows[0];
            const sqlInsert = `
                INSERT INTO customers (user_id, name, phone, address, prov, district, ward, newward, newprov) 
                VALUES ((SELECT id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?, ?, ?)`;

            await db.promise().query(sqlInsert, [username, name, phone, address, jt.prov, jt.district, jt.ward, jt.newward, jt.newprov]);

            createLog(`Đã thêm khách hàng mới: ${name}`, username);

            return res.json({
                success: true,
                tinh: jt.prov,
                huyen: jt.district,
                xa: jt.ward,
                newward: jt.newward,
                newprov: jt.newprov,
                message: `Đã thêm khách hàng ${name} thành công!`
            });
        } else {
            return res.json({
                success: false,
                message: `Địa chỉ này Viettel hiểu nhưng J&T không có: ${xa} - ${huyen} - ${tinh}.`
            });
        }

    } catch (error) {
        console.error("CRASH TRONG CUSTOMERS/ADD:", error);
        return res.json({ success: false, message: "Lỗi hệ thống: " + error.message });
    }
});

// Load địa chỉ 3 cấp một lần khi khởi động
let addressData = [];

// Normalize tiếng Việt: bỏ dấu, lowercase, đ→d
function normalizeAddr(str) {
    return str.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'd');
}

try {
    const raw = fs.readFileSync(path.join(__dirname, 'addresses3cap.json'), 'utf-8');
    addressData = JSON.parse(raw).map(item => {
        const wardClean = item.ward.replace(/-[A-Z0-9]+$/, '').trim();
        const full = `${wardClean}, ${item.district}, ${item.province}`;
        return {
            ward: wardClean,
            district: item.district,
            province: item.province,
            full: full,
            norm: normalizeAddr(full)  // Pre-compute normalized string
        };
    });
    console.log(`[Address] Đã load ${addressData.length} địa chỉ`);
} catch (e) {
    console.warn('[Address] Không load được addresses3cap.json:', e.message);
}

app.get('/api/address-suggest', (req, res) => {
    const q = normalizeAddr((req.query.q || '').trim());
    if (!q || q.length < 2) return res.json([]);

    // Tách keywords: bỏ dấu câu, bỏ trùng lặp, bỏ từ quá ngắn (1 ký tự)
    const rawKeywords = q.split(/[\s,;.\-\/\\]+/).filter(k => k.length > 1);
    const keywords = [...new Set(rawKeywords)]; // deduplicate

    if (keywords.length === 0) return res.json([]);

    const scored = addressData
        .map(item => {
            const text = item.norm; // "xa ninh hai, huyen ninh giang, hai duong"
            const wardNorm = normalizeAddr(item.ward); // "xa ninh hai"

            // Đếm unique keywords khớp trong toàn bộ địa chỉ
            const matches = keywords.filter(k => text.includes(k)).length;
            if (matches === 0) return null;

            // Bonus: keyword khớp chính xác với ward (quan trọng nhất)
            const wardMatches = keywords.filter(k => wardNorm.includes(k)).length;
            const wardBonus = wardMatches * 2;

            // Bonus nhỏ: tất cả keywords đều khớp
            const allMatch = matches === keywords.length ? 1 : 0;

            return { item, score: matches + wardBonus + allMatch };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(r => r.item);

    res.json(scored);
});

app.post('/api/validate-address', isAuth, async (req, res) => {
    const { address, name, phone } = req.body;
    const username = req.app_user;

    if (!address) return res.json({ success: false, message: "Thiếu địa chỉ!" });
    if (!phone || phone.length != 10) return res.json({ success: false, message: "Sai số điện thoại, kiểm tra lại!" });
    try {
        const [tokenRows] = await db.promise().query('SELECT vtp_token FROM viettel_connect LIMIT 1');
        if (tokenRows.length === 0 || !tokenRows[0].vtp_token) {
            return res.json({ success: false, message: "Hệ thống chưa có Token Viettel!" });
        }
        const systemToken = tokenRows[0].vtp_token;

        const vtpRes = await axios.post(`https://partner.viettelpost.vn/v2/order/getPriceAllNlp`, {
            "SENDER_ADDRESS": "Long Bình, Biên Hòa, Đồng Nai",
            "RECEIVER_ADDRESS": address,
            "PRODUCT_TYPE": "HH",
            "PRODUCT_WEIGHT": 100,
            "TYPE": 1
        }, {
            headers: { 'Content-Type': 'application/json', 'token': systemToken },
            timeout: 10000
        });

        const body = vtpRes.data;
        if (body.error == true || !body.RECEIVER_ADDRESS || !body.RECEIVER_ADDRESS.WARD_ID) {
            return res.json({ success: false, message: "Không nhận diện được địa chỉ này!" });
        }

        let tinh = "", huyen = "", xa = "";
        const [res1, res2, res3] = await Promise.all([
            axios.get(`https://partner.viettelpost.vn/v2/categories/listProvinceById?provinceId=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/districtByIdAndProvince?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&provinceById=${body.RECEIVER_ADDRESS.PROVINCE_ID}`),
            axios.get(`https://partner.viettelpost.vn/v2/categories/wardByDistrictAndId?districtId=${body.RECEIVER_ADDRESS.DISTRICT_ID}&wardsId=${body.RECEIVER_ADDRESS.WARD_ID}`)
        ]);

        tinh = res1.data.data?.[0]?.PROVINCE_NAME || "";
        huyen = res2.data.data?.DISTRICT_NAME || "";
        xa = res3.data.data?.WARDS_NAME || "";

        const sProv = cleanSearchTerm(tinh);
        let sDist = cleanSearchTerm(huyen);
        let sWard = cleanSearchTerm(xa);
        sWard = sWard.replace(/phường|xã/gi, "").trim();
        ({ sWard, sDist } = applyAddressFixes(sWard, sDist));
        const findJT = `
    SELECT * 
    FROM jtaddress
    WHERE 
        ${normalizeSQL('LOWER(prov)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND ${normalizeSQL('LOWER(district)')} LIKE ${normalizeSQL('LOWER(?)')}
        AND (
            ${normalizeSQL('LOWER(ward)')} LIKE ${normalizeSQL('LOWER(?)')}
        )
    ORDER BY 
        (LOWER(ward) LIKE ?) DESC,
        (LOWER(district) = ?) DESC,
        LENGTH(ward) ASC
    LIMIT 1`;

        const [jtRows] = await db.promise().query(findJT, [
            `%${sProv}%`,
            `%${sDist}%`,
            `%${sWard}%`,
            `${sWard}%`,
            sDist
        ]);

        if (jtRows && jtRows.length > 0) {
            const jt = jtRows[0];
            const upsertSql = `
    INSERT INTO customers (user_id, phone, prov, district, ward, name, address, newward, newprov)
    SELECT id, ?, ?, ?, ?, ?, ?, ?, ?
    FROM users 
    WHERE username = ?
    ON DUPLICATE KEY UPDATE 
        address = VALUES(address),
        prov = VALUES(prov), 
        district = VALUES(district),
        ward = VALUES(ward),
        name = VALUES(name),
        newward = VALUES(newward),
        newprov = VALUES(newprov)
`;

            // Thứ tự mảng phải là: 8 cái cho SELECT + 1 cái cho WHERE username
            await db.promise().query(upsertSql, [
                phone,        // 1
                jt.prov,      // 2
                jt.district,  // 3
                jt.ward,      // 4
                name,         // 5
                address,      // 6
                jt.newward,   // 7
                jt.newprov,   // 8
                username      // 9 (Đây là dấu hỏi cuối cùng của WHERE username = ?)
            ]);
            return res.json({
                success: true,
                data: {
                    prov: jt.prov,
                    district: jt.district,
                    ward: jt.ward,
                    newward: jt.newward,
                    newprov: jt.newprov,
                    fullStr: `${jt.ward}, ${jt.district}, ${jt.prov}`
                }
            });
        } else {
            return res.json({ success: false, message: "Địa chỉ Viettel hiểu nhưng J&T chưa có dữ liệu vùng này!" });
        }

    } catch (e) {
        console.error("Lỗi Validate Address:", e.message);
        return res.json({ success: false, message: "Lỗi kết nối hoặc hệ thống bận!" });
    }
});

app.get('/admin/orders', isManager, async (req, res) => {
    if (!req.app_user) return res.redirect('/login');
    const username = req.app_user;
    const { search, status, provider, startDate, endDate, dateType, printed } = req.query;
    const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

    try {
        const [userRows] = await db.promise().query(`SELECT * FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.redirect('/login');
        const currentUser = userRows[0];

        let baseConditions = [];
        let baseParams = [];

        if (startDate && endDate) {
            baseConditions.push(`DATE(${dateField}) BETWEEN ? AND ?`);
            baseParams.push(startDate, endDate);
        } else if (!search) {
            baseConditions.push(`DATE(${dateField}) >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)`);
        }

        let multiCodes = null; // lưu lại để dùng cho ORDER BY FIELD

        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                // Tìm nhiều mã cùng lúc — dùng IN
                multiCodes = codes;
                const placeholders = codes.map(() => '?').join(',');
                baseConditions.push(`(order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders}))`);
                baseParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                baseConditions.push("customer_phone LIKE ?");
                baseParams.push(`%${search}`);
            } else {
                baseConditions.push("(order_code LIKE ? OR realjtbillcode LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)");
                const s = `%${search}%`;
                baseParams.push(s, s, s, s);
            }
        }
        if (provider) {
            baseConditions.push("provider = ?");
            baseParams.push(provider);
        }

        const baseSql = baseConditions.length > 0 ? " WHERE " + baseConditions.join(" AND ") : "";

        const countSql = `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status IN ('picked_up', 'delivering') THEN 1 ELSE 0 END) as shipping,
                SUM(CASE WHEN status = 'out_for_delivery' THEN 1 ELSE 0 END) as delivery,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status IN ('returning', 'returned') THEN 1 ELSE 0 END) as returned,
                SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) as issue,
                SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END) as cancel,
                SUM(CASE WHEN is_printed > 0 THEN 1 ELSE 0 END) as printed,
                SUM(CASE WHEN is_printed = 0 THEN 1 ELSE 0 END) as not_printed
            FROM orders ${baseSql}`;

        const [countRows] = await db.promise().query(countSql, baseParams);
        const counts = countRows[0] || { total: 0, pending: 0, shipping: 0, delivery: 0, completed: 0, returned: 0, issue: 0, cancel: 0, printed: 0, not_printed: 0 };

        let finalConditions = [...baseConditions];
        let finalParams = [...baseParams];

        if (status) {
            if (status === 'delivering') finalConditions.push("status IN ('picked_up', 'delivering')");
            else if (status === 'returned') finalConditions.push("status IN ('returning', 'returned')");
            else { finalConditions.push("status = ?"); finalParams.push(status); }
        }

        // Lọc theo trạng thái in
        if (printed === '1') {
            finalConditions.push("is_printed > 0");
        } else if (printed === '0') {
            finalConditions.push("is_printed = 0");
        }

        const finalWhereClause = finalConditions.length > 0 ? " WHERE " + finalConditions.join(" AND ") : "";

        // Nếu tìm nhiều mã: giữ đúng thứ tự quét bằng FIELD()
        let orderByClause;
        let orderSqlParams;
        if (multiCodes && multiCodes.length > 1) {
            const fieldPlaceholders = multiCodes.map(() => '?').join(',');
            orderByClause = `ORDER BY FIELD(o.order_code, ${fieldPlaceholders}), FIELD(o.realjtbillcode, ${fieldPlaceholders})`;
            orderSqlParams = [...finalParams, ...multiCodes, ...multiCodes];
        } else {
            orderByClause = `ORDER BY o.created_at DESC`;
            orderSqlParams = [...finalParams];
        }

        const orderSql = `
            SELECT o.*, u.shopname
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            ${finalWhereClause}
            ${orderByClause}`;

        const [orders] = await db.promise().query(orderSql, orderSqlParams);
        const [customerRows] = await db.promise().query('SELECT * FROM customers WHERE user_id = ?', [currentUser.id]);
        const [noteRows] = await db.promise().query('SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC', [currentUser.id]);
        const [productRows] = await db.promise().query('SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC', [currentUser.id]);

        res.render('admin_orders', {
            getBadge,
            orders: orders,
            stats: currentUser,
            counts: counts,
            customers: customerRows || [],
            notes: noteRows || [],
            products: productRows || [],
            search: search || '',
            status: status || '',
            provider: provider || '',
            startDate: startDate || '',
            endDate: endDate || '',
            dateType: dateType || 'created',
            printed: printed !== undefined ? printed : '',
            isFiltering: !!(search || status || provider || startDate || endDate || printed !== undefined),
            currentRole: req.app_role,
            use_socket_print: currentUser.use_socket_print || 0,
            user: username,
            active: 'orders'
        });

    } catch (err) {
        console.error("LỖI NGHIÊM TRỌNG TẠI ROUTE ADMIN:", err);
        res.status(500).send("Lỗi hệ thống: " + err.message);
    }
});

app.get('/orders', async (req, res) => {
    if (!req.app_user) return res.redirect('/login');
    const username = req.app_user;
    const { search, status, provider, startDate, endDate, dateType, printed } = req.query;
    const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

    try {
        const [userRows] = await db.promise().query(`SELECT id FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.redirect('/login');
        const userId = userRows[0].id;

        let baseConditions = ["user_id =?"];
        let baseParams = [userId];

        if (startDate && endDate) {
            baseConditions.push(`DATE(${dateField}) BETWEEN ? AND ?`);
            baseParams.push(startDate, endDate);
        } else if (!search) {
            baseConditions.push(`DATE(${dateField}) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`);
        }

        let multiCodes2 = null;
        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                multiCodes2 = codes;
                const placeholders = codes.map(() => '?').join(',');
                baseConditions.push(`(order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders}))`);
                baseParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                baseConditions.push("customer_phone LIKE?");
                baseParams.push(`%${search}`);
            } else {
                baseConditions.push("(customer_phone LIKE? OR order_code LIKE? OR realjtbillcode LIKE? OR customer_name LIKE?)");
                const s = `%${search}%`;
                baseParams.push(s, s, s, s);
            }
        }
        if (provider) {
            baseConditions.push("provider =?");
            baseParams.push(provider);
        }

        const baseSql = baseConditions.length > 0 ? " WHERE " + baseConditions.join(" AND ") : "";

        const [countRows] = await db.promise().query(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status IN ('picked_up', 'delivering') THEN 1 ELSE 0 END) as shipping,
                SUM(CASE WHEN status = 'out_for_delivery' THEN 1 ELSE 0 END) as delivery,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status IN ('returning', 'returned') THEN 1 ELSE 0 END) as returned,
                SUM(CASE WHEN status = 'issue' THEN 1 ELSE 0 END) as issue,
                SUM(CASE WHEN status = 'cancel' THEN 1 ELSE 0 END) as cancel,
                SUM(CASE WHEN is_printed > 0 THEN 1 ELSE 0 END) as printed,
                SUM(CASE WHEN is_printed = 0 THEN 1 ELSE 0 END) as not_printed
            FROM orders ${baseSql}`,
            baseParams
        );
        const counts = countRows[0] || { total: 0, pending: 0, shipping: 0, delivery: 0, completed: 0, returned: 0, issue: 0, cancel: 0, printed: 0, not_printed: 0 };

        let finalConditions = [...baseConditions];
        let finalParams = [...baseParams];

        if (status) {
            if (status === 'delivering') {
                finalConditions.push("status IN ('picked_up', 'delivering')");
            } else if (status === 'returned') {
                finalConditions.push("status IN ('returning', 'returned')");
            } else {
                finalConditions.push("status = ?");
                finalParams.push(status);
            }
        }

        // Lọc theo trạng thái in
        if (printed === '1') {
            finalConditions.push("is_printed > 0");
        } else if (printed === '0') {
            finalConditions.push("is_printed = 0");
        }

        const finalWhereClause = " WHERE " + finalConditions.join(" AND ");

        // Giữ đúng thứ tự quét khi tìm nhiều mã
        let finalSql;
        let finalSqlParams;
        if (multiCodes2 && multiCodes2.length > 1) {
            const fp = multiCodes2.map(() => '?').join(',');
            finalSql = `SELECT * FROM orders ${finalWhereClause} ORDER BY FIELD(order_code, ${fp}), FIELD(realjtbillcode, ${fp})`;
            finalSqlParams = [...finalParams, ...multiCodes2, ...multiCodes2];
        } else {
            finalSql = `SELECT * FROM orders ${finalWhereClause} ORDER BY created_at DESC`;
            finalSqlParams = [...finalParams];
        }

        const isFiltering = !!(search || status || provider || startDate || endDate || printed !== undefined);

        const [orders] = await db.promise().query(finalSql, finalSqlParams);

        const [fullUser] = await db.promise().query(`SELECT * FROM users WHERE id = ?`, [userId]);
        const [customerRows] = await db.promise().query('SELECT * FROM customers WHERE user_id = ?', [userId]);
        const [noteRows] = await db.promise().query('SELECT content FROM order_notes WHERE user_id = ? ORDER BY created_at DESC', [userId]);
        const [productRows] = await db.promise().query('SELECT product_name FROM order_products WHERE user_id = ? ORDER BY created_at DESC', [userId]);

        res.render('orders', {
            getBadge,
            orders,
            stats: fullUser[0] || {},
            counts,
            customers: customerRows || [],
            notes: noteRows || [],
            products: productRows || [],
            search: search || '',
            status: status || '',
            provider: provider || '',
            startDate: startDate || '',
            endDate: endDate || '',
            dateType: dateType || 'created',
            printed: printed !== undefined ? printed : '',
            isFiltering,
            use_socket_print: fullUser[0] ? (fullUser[0].use_socket_print || 0) : 0,
            user: username,
            active: 'orders'
        });

    } catch (err) {
        console.error("Lỗi:", err);
        res.status(500).send("Lỗi hệ thống");
    }
});

app.get('/api/orders', isAuth, async (req, res) => {
    try {
        // Lấy username từ req.app_user (đã được isAuth giải mã) hoặc req.app_user
        const username = req.app_user;

        const [userRows] = await db.promise().query(`SELECT id FROM users WHERE username = ?`, [username]);
        if (userRows.length === 0) return res.status(404).json([]);

        const userId = userRows[0].id;
        const [orders] = await db.promise().query(
            `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );

        res.json(orders);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/admin/update-vtp-system', isAdmin, async (req, res) => {
    const { vtp_user, vtp_pass } = req.body;

    try {
        const loginRes = await axios.post('https://partner.viettelpost.vn/v2/user/login', {
            USERNAME: vtp_user,
            PASSWORD: vtp_pass
        });

        if (loginRes.data.status !== 200) {
            return res.json({ success: false, message: "Tài khoản/Mật khẩu VTP không đúng" });
        }

        const tempToken = loginRes.data.data.token;

        const connectRes = await axios.post('https://partner.viettelpost.vn/v2/user/ownerconnect', {
            USERNAME: vtp_user,
            PASSWORD: vtp_pass
        }, {
            headers: { 'token': tempToken }
        });

        if (connectRes.data.status === 200) {
            const tk = connectRes.data.data;

            const sql = `
                UPDATE viettel_connect 
                SET vtp_username = ?, 
                    vtp_password = ?, 
                    vtp_token = ?, 
                    vtp_token_exp = ?, 
                    vtp_cusid = ? 
                WHERE id = 1`;

            await db.promise().query(sql, [vtp_user, vtp_pass, tk.token, tk.expired, tk.userId]);

            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Lỗi Connect: " + connectRes.data.message });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: "Không kết nối được API Viettel" });
    }
});

app.get('/api/viettel/inventories', async (req, res) => {
    try {
        const [config] = await db.promise().query('SELECT vtp_token FROM viettel_connect WHERE id = 1');

        if (!config[0] || !config[0].vtp_token) {
            return res.status(401).json({ error: "Hệ thống chưa kết nối Viettel Post" });
        }

        const response = await axios.get('https://partner.viettelpost.vn/v2/user/list-inventory', {
            headers: { 'Token': config[0].vtp_token }
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Lỗi kết nối API Viettel" });
    }
});

app.post('/admin/assign-vtp-shop', isAdmin, async (req, res) => {
    const { userId, shopData } = req.body;

    const inventoryId = parseInt(shopData.inventoryId) || 0;

    try {
        const sql = `UPDATE users SET vtp_inventory_id = ?, vtp_shop_name = ?, vtp_shop_phone = ?, vtp_shop_address = ? WHERE id = ?`;
        await db.promise().query(sql, [inventoryId, shopData.name, shopData.phone, shopData.address, userId]);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});
function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}
app.post('/api/orders/create', isAuth, async (req, res) => {
    const {
        provider, customer_name, customer_phone, address, product_name, weight,
        note, ward, district, province, is_partial_delivery, is_new_address, newward, newprov,
        jt_shopname, jt_sdt, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov
    } = req.body;
    let tinh = province
    let xa = ward;
    let huyen = district;
    const username = req.app_user;
    if (!username) return res.status(401).json({ success: false, message: "Hết phiên làm việc!" });

    if (!ward) return res.json({ success: false, message: "Bấm nút kiểm tra địa chỉ trước nha." });
    if (!newward || !newprov) return res.json({ success: false, message: "Địa chỉ chưa được kiểm tra hoặc không tìm thấy vùng J&T, vui lòng bấm \"Kiểm tra địa chỉ\" lại!" });
    if (!customer_name || !customer_phone || !address) return res.json({ success: false, message: "Thiếu thông tin khách hàng!" });
    if (customer_phone.length != 10) return res.json({ success: false, message: "Số điện thoại khách hàng sai!" });

    var cod = req.body.cod.toString().replaceAll(".", '');
    if (!isNumeric(cod)) {
        cod = 0;
    }
    const typecod = Number(cod) > 0 ? 3 : 1;

    try {
        const [userRows] = await db.promise().query('SELECT * FROM users WHERE username = ?', [username]);
        const [vtpRows] = await db.promise().query('SELECT vtp_token, vtp_cusid FROM viettel_connect WHERE id = 1');

        const user = userRows[0];
        const vtpConfig = vtpRows[0];

        const inputWeight = parseFloat(weight) || 0.5;
        const uBasePrice = Number(user.base_price) || 20000;
        const uStepPrice = Number(user.step_price) || 5000;
        const uBaseWeight = Number(user.base_weight) || 2;

        let calculatedFee = uBasePrice;

        const billableWeight = Math.ceil(inputWeight);

        if (billableWeight > uBaseWeight && uStepPrice > 0) {
            const extraKg = billableWeight - uBaseWeight;
            calculatedFee += extraKg * uStepPrice;
        }

        const upsertSql = `
                INSERT INTO customers (user_id, phone, address, prov, district, ward, name, newward, newprov)
                VALUES ((SELECT id FROM users WHERE username = ?), ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    prov = VALUES(prov), 
                    district = VALUES(district), 
                    ward = VALUES(ward),
                    name = VALUES(name),
                    newward = VALUES(newward),
                    newprov = VALUES(newprov)
                `;

        await db.promise().query(upsertSql, [username, customer_phone, address, province, district, ward, customer_name, newward, newprov]);

        if (provider === 'Viettel') {
            if (!user || !user.vtp_inventory_id) return res.json({ success: false, message: "Chưa gán kho hàng cho tài khoản này!" });
            if (!vtpConfig || !vtpConfig.vtp_token) return res.json({ success: false, message: "Hệ thống chưa cấu hình kết nối Viettel!" });
            const vtp_data = {
                "ORDER_NUMBER": "TV" + Date.now(),
                "GROUPADDRESS_ID": user.vtp_inventory_id,
                "CUS_ID": vtpConfig.vtp_cusid,
                "SENDER_FULLNAME": user.vtp_shop_name,
                "SENDER_ADDRESS": user.vtp_shop_address,
                "SENDER_PHONE": user.vtp_shop_phone,
                "RECEIVER_FULLNAME": customer_name,
                "RECEIVER_ADDRESS": address,
                "RECEIVER_PHONE": customer_phone,
                "PRODUCT_NAME": product_name,
                "PRODUCT_DESCRIPTION": product_name,
                "PRODUCT_QUANTITY": 1,
                "PRODUCT_PRICE": cod,
                "PRODUCT_WEIGHT": Number(inputWeight) * 1000,
                "PRODUCT_LENGTH": 1, "PRODUCT_WIDTH": 1, "PRODUCT_HEIGHT": 1,
                "PRODUCT_TYPE": "HH",
                "ORDER_PAYMENT": typecod,
                "ORDER_SERVICE": "VSL7",
                "ORDER_NOTE": note,
                "MONEY_COLLECTION": cod,
                "IS_ADDRESS_NEW": false
            };

            const response = await axios.post('https://partner.viettelpost.vn/v2/order/createOrder', vtp_data, {
                headers: { 'Content-Type': 'application/json', 'Token': vtpConfig.vtp_token },
                timeout: 15000
            });

            const result = response.data;
            if (result && result.status === 200) {
                const vtp_code = result.data.ORDER_NUMBER;
                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, original_cod, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlOrder, [user.id, vtp_code, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, inputWeight, 'pending', cod, newward, newprov]);
                return res.json({ success: true, order_code: vtp_code, internal_fee: calculatedFee });
            } else {
                return res.json({ success: false, message: result.message || "Viettel Post từ chối đơn hàng" });
            }

        } else if (provider === 'J&T') {// check kho jt trước khi cho đẩy đơn
            /*const NB_BIEN_HOA_WARDS = [
                'an bình', 'tam hiệp', 'bình đa', 'tân hiệp', 'tân mai',
                'tân tiến', 'tân biên', 'hố nai', 'hoá an', 'hóa an',
                'bửu hoà', 'bửu hòa', 'bửu long', 'quang vinh', 'quyết thắng',
                'hiệp hoà', 'hiệp hòa', 'trảng dài', 'long bình', 'tân hòa', 'tân hoà'
            ];*/
            const NB_BIEN_HOA_WARDS = [
                'an bình', 'tam hiệp', 'bình đa', 'tân hiệp', 'tân mai',
                'tân tiến', 'tân biên', 'hố nai', 'hoá an', 'hóa an',
                'bửu hoà', 'bửu hòa', 'bửu long', 'quang vinh', 'quyết thắng',
                'hiệp hoà', 'hiệp hòa', 'trảng dài', 'long bình', 'tân hòa', 'tân hoà',
                'tam hoà', 'tam hòa'
            ];
 
            function normalizeWardNB(s) {
                return (s || '').toLowerCase().normalize('NFC')
                    .replace(/phường|xã|thị trấn/gi, '').trim();
            }
 
            const wardNormNB = normalizeWardNB(ward);
            const districtNormNB = normalizeWardNB(district);
            const isNBWard = NB_BIEN_HOA_WARDS.some(w => wardNormNB.includes(w) || w.includes(wardNormNB));
            const isNBDistrict = districtNormNB.includes('biên hòa') || districtNormNB.includes('biên hoà');
            const enable = true;
            if (enable && isNBWard && isNBDistrict && ward != 'Phường Long Bình Tân-251TPB08') {
                const maNB = 'BH' + Date.now();
                const sqlNBOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlNBOrder, [user.id, maNB, 'NB', customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', null, cod, ward, district, province, 'NB-TVSHIP-BH', note]);
                return res.json({ success: true, message: `✅ Địa chỉ nội thành Biên Hòa — tự động chuyển sang đơn Nội Bộ`, order_code: maNB});
            }

            if (is_new_address) {
                tinh = newprov;
                xa = newward;
                huyen = '';
            }
            const pkey = 'a773fde3cd06466a83232a9f5df4c17a';
            const apiAccount = '879924327569523968';//api key YmXbZ1V5
            const matuquan = "TV" + Date.now();
            if (!jt_sdt || !jt_shopname || !jt_shopaddress) return res.json({ success: false, message: "Thiếu thông tin người gửi J&T!" });
            const oderjson = JSON.stringify({
                "customerCode": "251LC20090",
                "password": "7518ED172D9CAF92E13AC20B18227359",
                "txlogisticId": matuquan,
                "productType": "EXPRESS",
                "orderType": "1",
                "serviceType": "1",
                "partSign": is_partial_delivery,
                "deliveryType": "1",
                "totalQuantity": 1,
                "sender": { "name": jt_shopname, "mobile": jt_sdt, "prov": jt_shop_prov, "city": jt_shop_district, "area": jt_shop_ward, "address": jt_shopaddress },
                "receiver": { "name": customer_name, "mobile": customer_phone, "prov": tinh, "city": huyen, "area": xa, "address": address },
                "payType": "PP_PM",
                "goodsType": "bm000010",
                "goodsValue": cod.toString(),
                "codMoney": cod.toString(),
                "itemsValue": cod.toString(),
                "remark": note,
                "englishName": "none",
                "packageInfo": { "weight": weight, "length": 10, "width": 10, "height": 10, "volume": "10" },
                "items": [{ "itemName": product_name, "englishName": "None", "number": 1, "itemValue": cod }]
            });

            const digest = md5ToBase64(oderjson + pkey);
            const params = new URLSearchParams();
            params.append('bizContent', oderjson);

            const response = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/addOrder', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'apiAccount': apiAccount,
                    'digest': digest,
                    'timestamp': Date.now().toString()
                },
                timeout: 5000
            });

            const body = response.data;
            if (body.msg === 'success') {
                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
                await db.promise().query(sqlOrder, [user.id, matuquan, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', body.data.billCode, cod, ward, district, province, body.data.sortLine, note, newward, newprov]);
                GetBillJT(matuquan);
                return res.json({ success: true, message: "Lên đơn J&T thành công", order_code: body.data.billCode });
            } else {
                return res.json({ success: false, message: "J&T từ chối: " + body.msg });
            }
        } else if (provider === 'GHN') {
            const ghn_token = '62eca188-17e2-11f1-bf0d-daf9f7d42901';
            const ghn_shopid = '5393581';

            const ghn_data = {
                "payment_type_id": 1, //1 là người gửi trả cước, 2 là người nhận
                "note": note || "Không cho xem hàng!",
                "required_note": "KHONGCHOXEMHANG",
                "return_phone": user.vtp_shop_phone || "0332190158", // Tận dụng phone shop có sẵn
                "return_address": user.vtp_shop_address || "39 NTT",
                "from_name": user.vtp_shop_name || "TinTest124",
                "from_phone": user.vtp_shop_phone || "0987654321",
                "from_address": user.vtp_shop_address || "72 Thành Thái, Quận 10, HCM",
                "to_name": customer_name,
                "to_phone": customer_phone,
                "to_address": address,
                "to_ward_name": ward,//cần lấy chuẩn lại GHN theo query của JT, hoặc code thêm cột cho bảng customers
                "to_district_name": district,
                "to_province_name": province,
                "cod_amount": Number(cod),
                "content": product_name,
                "weight": Math.round(Number(inputWeight) * 1000), // GHN dùng gram
                "length": 10,
                "width": 10,
                "height": 10,
                "insurance_value": Number(cod), // BH theo COD
                "service_type_id": 2, // Hàng nhẹ/Chuẩn
                "items": [
                    {
                        "name": product_name,
                        "quantity": 1,
                        "price": Number(cod),
                        "weight": Math.round(Number(inputWeight) * 1000)
                    }
                ]
            };

            const response = await axios.post('https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create', ghn_data, {
                headers: {
                    'Content-Type': 'application/json',
                    'ShopId': ghn_shopid,
                    'Token': ghn_token
                },
                timeout: 5000
            });

            const result = response.data;

            if (result && result.code === 200) {
                const ghn_order_code = result.data.order_code;
                const ghn_fee = result.data.total_fee;

                const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, original_cod, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;

                await db.promise().query(sqlOrder, [
                    user.id,
                    ghn_order_code,
                    provider,
                    customer_name,
                    customer_phone,
                    address,
                    product_name,
                    cod,
                    calculatedFee,
                    inputWeight,
                    'pending',
                    cod,
                    note
                ]);

                return res.json({
                    success: true,
                    message: result.message_display, // "Tạo đơn hàng thành công. Mã đơn hàng: ..."
                    order_code: ghn_order_code,
                    ghn_fee: ghn_fee, // Phí thực tế GHN thu
                    internal_fee: calculatedFee // Phí hệ thống bạn tính
                });
            } else {
                return res.json({
                    success: false,
                    message: "GHN từ chối: " + (result.message || "Lỗi không xác định")
                });
            }
        } else if (provider === 'NB') {
            const matuquan = "BH" + Date.now();
            const sqlOrder = `INSERT INTO orders (user_id, order_code, provider, customer_name, customer_phone, customer_address, product_name, price, internal_fee, weight, status, realjtbillcode, original_cod, jt_ward, jt_district, jt_prov, sortLine, note, newward, newprov, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
            await db.promise().query(sqlOrder, [user.id, matuquan, provider, customer_name, customer_phone, address, product_name, cod, calculatedFee, weight, 'pending', null, cod, ward, district, province, 'NB-TVSHIP-BH', note, newward, newprov]);
            return res.json({ success: true, message: "Lên đơn Biên Hòa thành công", order_code: matuquan });
        }
    } catch (err) {
        console.error("Lỗi Create Order:", err.message);
        return res.status(500).json({ success: false, message: "Lỗi hệ thống: " + err.message });
    }
});

function md5ToBase64(input) {
    const md5Hash = CryptoJS.MD5(input);
    const wordArray = md5Hash;
    const base64String = CryptoJS.enc.Base64.stringify(wordArray);
    return base64String;
}

app.get('/api/print-order/:id', async (req, res) => {//hiện tại ko xài cái này, 
    try {
        const [rows] = await db.promise().query('SELECT * FROM orders WHERE realjtbillcode = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).send("Không thấy đơn");

        const order = rows[0];
        const sort = order.sortLine ? order.sortLine.split('-') : ['', '', '', ''];

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [order.user_id]);
        const user = users[0];
        const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: order.realjtbillcode,
            scale: 3,
            height: 10,
            includetext: false,
        });
        const barcodeBase64 = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

        const qrBase64 = await QRCode.toDataURL(order.realjtbillcode, {
            margin: 1,
            width: 150
        });

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                @page { size: 80mm 80mm; margin: 0; }
                * { box-sizing: border-box; margin: 0; padding: 0; line-height: 1.1; }
                body { width: 80mm; height: 80mm; font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; }
                .label-container { width: 76mm; height: 76mm; border: 2px solid #000; display: flex; flex-direction: column; overflow: hidden; background: #fff; }
                
                /* Barcode */
                .section-barcode { height: 14mm; border-bottom: 2px solid #000; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 0; }
                .barcode-img { width: 85%; height: 8mm; }
                .order-id { font-size: 12px; font-weight: bold; margin-top: 1px; }

                /* Sortline: 620 | B256C03 | 002 */
                .section-sortline { height: 10mm; border-bottom: 2.5px solid #000; display: grid; grid-template-columns: 1fr 1.5fr 1fr; text-align: center; font-weight: bold; }
                .sort-item { display: flex; align-items: center; justify-content: center; border-right: 1.5px solid #000; font-size: 20px; }
                .sort-item:last-child { border-right: none; }
                .sub-code { font-size: 14px; }

                /* Địa chỉ */
                .section-addresses { height: 24mm; border-bottom: 1.5px solid #000; padding: 4px; font-size: 11px; display: flex; flex-direction: column; justify-content: space-around; }

                /* Bottom: Note & QR */
                .section-bottom { height: 20mm; display: grid; grid-template-columns: 1fr 20mm; border-bottom: 2.5px solid #000; }
                .note-box { padding: 3px; font-size: 9px; font-weight: bold; text-transform: uppercase; border-right: 1.5px solid #000; display: flex; align-items: center; text-align: center; }
                .qr-box { display: flex; flex-direction: column; align-items: center; justify-content: center; }
                .qr-img { width: 17mm; height: 17mm; }

                /* COD */
                .section-cod { flex-grow: 1; padding-left: 8px; display: flex; align-items: center; font-size: 15px; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="label-container">
                <div class="section-barcode">
                    <img src="${barcodeBase64}" class="barcode-img">
                    <div class="order-id">${order.realjtbillcode}</div>
                </div>
                <div class="section-sortline">
                    <div class="sort-item">${sort[0]}</div>
                    <div class="sort-item">${sort[1]}</div>
                    <div class="sort-item">${sort[2]}</div>
                </div>
                <div class="section-addresses">
                    <div><b>GỬI: ${user.jt_shopname}</b> - ${user.jt_sdt}</div>
                    <div><b>NHẬN: ${order.customer_name}</b> - ${order.customer_phone}<br>${order.customer_address}</div>
                </div>
                <div class="section-bottom">
                    <div class="note-box">${order.note || 'KHÔNG CHO XEM HÀNG'}<br><br>${order.product_name}</div>
                    <div class="qr-box">
                        <img src="${qrBase64}" class="qr-img">
                    </div>
                </div>
                <div class="section-cod">TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ</div>
            </div>
            <script>
                window.onload = () => {
                    window.print();
                    window.onafterprint = () => { window.parent.postMessage('close-print-frame', '*'); };
                    setTimeout(() => { window.parent.postMessage('close-print-frame', '*'); }, 2000);
                };
            </script>
        </body>
        </html>`;

        res.send(htmlContent);
    } catch (err) { res.status(500).send(err.message); }
});

// Puppeteer không còn dùng — render PDF qua pdfkit (renderLabelsToPdfBuffer)
// ──────────────────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit');

// Helper: query đơn hàng theo ids, GIỮ ĐÚNG THỨ TỰ ids từ client
async function queryOrdersByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
        SELECT * FROM orders
        WHERE order_code IN (${placeholders}) OR realjtbillcode IN (${placeholders})
        GROUP BY id
    `;
    const [rows] = await db.promise().query(sql, [...ids, ...ids]);
    // Sort bằng JS để đảm bảo đúng thứ tự ids bất kể match qua order_code hay realjtbillcode
    const indexMap = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => {
        const ia = indexMap.has(a.realjtbillcode) ? indexMap.get(a.realjtbillcode) : (indexMap.get(a.order_code) ?? 9999);
        const ib = indexMap.has(b.realjtbillcode) ? indexMap.get(b.realjtbillcode) : (indexMap.get(b.order_code) ?? 9999);
        return ia - ib;
    });
    return rows;
}

// ─── Shared pdfkit renderer — dùng cho cả mobile và socket print ──────────────
// Không cần Puppeteer, không có queue, không có bottleneck
// ~10-30ms/batch thay vì ~200ms
let _logoBuffer = null;   // Buffer — cho pdfkit
let _logoBase64 = null;   // base64 data URL — cho HTML <img src>

function getLogoBuffer() {
    if (_logoBuffer) return _logoBuffer;
    const logoPath = 'C:\\PushJTxVT\\public\\logo_tem.png';
    if (fs.existsSync(logoPath)) {
        _logoBuffer = fs.readFileSync(logoPath);
        _logoBase64 = 'data:image/png;base64,' + _logoBuffer.toString('base64');
    }
    return _logoBuffer;
}

// Khởi tạo logo cache ngay khi server start
getLogoBuffer();

async function renderLabelsToPdfBuffer(orders, user, showCod) {
    const size80mm = 226.77;
    const doc = new PDFDocument({ size: [size80mm, size80mm], margins: { top: 0, left: 0, right: 0, bottom: 0 } });

    const fontPath        = 'C:\\PushJTxVT\\public\\Tahoma-Bold.ttf';
    const fontRegularPath = 'C:\\PushJTxVT\\public\\Tahoma.ttf';
    const colWidth        = 216.77 / 3;
    const firstColumnX    = 5 + colWidth;
    const logoBuffer      = getLogoBuffer();

    // Sinh barcode + QR song song cho toàn bộ orders
    const assets = await Promise.all(orders.map(async (order) => {
        const code = order.realjtbillcode || order.order_code;
        const [barcodeBuf, qrBuf] = await Promise.all([
            bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 10, includetext: false }),
            QRCode.toBuffer(code, { margin: 1, width: 100 })
        ]);
        return { order, code, barcodeBuf, qrBuf };
    }));

    for (let i = 0; i < assets.length; i++) {
        if (i > 0) doc.addPage();
        const { order, code, barcodeBuf, qrBuf } = assets[i];
        const sort = formatSortCode(order.sortLine);

        doc.lineWidth(1.5).rect(5, 5, 216.77, 216.77).stroke();

        // SECTION 1: LOGO & BARCODE
        doc.moveTo(5, 45).lineTo(221.77, 45).stroke();
        doc.moveTo(firstColumnX, 5).lineTo(firstColumnX, 45).stroke();
        if (logoBuffer) {
            doc.image(logoBuffer, 10, 8, { fit: [colWidth - 10, 32], align: 'center', valign: 'center' });
        }
        doc.image(barcodeBuf, firstColumnX + 10, 10, { width: 125, height: 20 });
        doc.font(fontPath).fontSize(9).text(code, firstColumnX, 32, { width: 221.77 - firstColumnX, align: 'center' });

        // SECTION 2: SORTLINE
        doc.moveTo(5, 75).lineTo(221.77, 75).stroke();
        const sortY = 50;
        doc.font(fontPath).fontSize(14);
        doc.text(sort[0] || '', 5, sortY, { width: colWidth, align: 'center' });
        doc.moveTo(firstColumnX, 45).lineTo(firstColumnX, 75).stroke();
        doc.text(sort[1] || '', firstColumnX, sortY, { width: colWidth, align: 'center' });
        doc.moveTo(firstColumnX + colWidth, 45).lineTo(firstColumnX + colWidth, 75).stroke();
        doc.text(sort[2] || '', firstColumnX + colWidth, sortY, { width: colWidth, align: 'center' });

        // SECTION 3: ĐỊA CHỈ
        doc.moveTo(5, 143).lineTo(221.77, 143).stroke();
        doc.font(fontPath).fontSize(9).text(`GỬI: ${user.jt_shopname || 'N/A'} - ${user.jt_sdt || ''}`, 10, 82);
        doc.moveDown(0.4);
        doc.text(`NHẬN: ${order.customer_name} - ${order.customer_phone}`);
        doc.font(fontRegularPath).fontSize(8.5).text(order.customer_address, { width: 205, lineGap: 1 });

        // SECTION 4: NOTE & QR
        const qrX = 160;
        doc.moveTo(qrX, 143).lineTo(qrX, 199).stroke();
        doc.moveTo(5, 199).lineTo(221.77, 199).stroke();
        doc.font(fontPath).fontSize(8).text(order.note || 'KHÔNG CHO XEM HÀNG', 10, 148, { width: qrX - 15 });
        doc.font(fontRegularPath).fontSize(12).text(`Hàng hóa: ${order.product_name || ''} x ${order.weight} KG`, 10, 185);
        doc.image(qrBuf, qrX + 4, 145, { width: 52, height: 52 });

        if (showCod) {
            doc.fillColor('#000000').font(fontPath).fontSize(13)
               .text(`TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ`, 5, 205, { align: 'center', width: 216 });
        }
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/print-orders-multi-mobile', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("ID không hợp lệ");

        const orders = await queryOrdersByIds(ids);
        if (orders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const pdfBuffer = await renderLabelsToPdfBuffer(orders, user, showCod);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=tem-80x80.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).send("Lỗi Server");
    }
});
app.post('/api/print-orders-multi-mobile2', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("Danh sách ID không hợp lệ");

        const orders = await queryOrdersByIds(ids);
        if (orders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const pdfBuffer = await renderLabelsToPdfBuffer(orders, user, showCod);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=tem-80x80.pdf');
        res.send(pdfBuffer);
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server: " + err.message);
    }
});


app.post('/api/print-orders-multi', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).send("Danh sách ID không hợp lệ");

        const orders = await queryOrdersByIds(ids);
        if (orders.length === 0) return res.status(404).send("Không thấy đơn nào");

        const firstOrder = orders[0];
        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [firstOrder.user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;

        const logoUrl = _logoBase64 || "https://tvship.vn/logo_tem.png";
        const labels = await Promise.all(orders.map(async (order) => {
            const sort = formatSortCode(order.sortLine);
            const code = order.realjtbillcode || order.order_code;
            const [barcodeBuffer, qrBase64] = await Promise.all([
                bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 10, includetext: false }),
                QRCode.toDataURL(code, { margin: 1, width: 150 })
            ]);
            const barcodeBase64 = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;
            return `
            <div class="page-break">
                <div class="label-container">
                    <div class="section-barcode">
                        <div class="logo-box"><img src="${logoUrl}" class="logo-img"></div>
                        <div class="barcode-box">
                            <img src="${barcodeBase64}" class="barcode-img">
                            <div class="order-id">${code}</div>
                        </div>
                    </div>
                    <div class="section-sortline">
                        <div class="sort-item">${sort[0] || ''}</div>
                        <div class="sort-item">${sort[1] || ''}</div>
                        <div class="sort-item">${sort[2] || ''}</div>
                    </div>
                    <div class="section-addresses">
                        <div><b>GỬI: ${user.jt_shopname || 'N/A'} - ${user.jt_sdt || ''}</b></div>
                        <div class="receiver-info">
                            <b>NHẬN: ${order.customer_name} - ${order.customer_phone}</b><br>
                            ${order.customer_address}
                        </div>
                    </div>
                    <div class="section-bottom">
                        <div class="note-box">
                            ${order.note || 'KHÔNG CHO XEM HÀNG'}<br><br>
                            <span style="font-weight:normal; font-size:10px; text-transform: none;">Hàng hóa: ${order.product_name || ''} x ${order.weight} KG</span>
                        </div>
                        <div class="qr-box"><img src="${qrBase64}" class="qr-img"></div>
                    </div>
                    <div class="section-cod">TIỀN THU HỘ: ${Number(order.price).toLocaleString()} VNĐ</div>
                </div>
            </div>`;
        }));
        res.send(generateFullHtml(labels.join(''), true, showCod));
    } catch (err) {
        console.error(err);
        res.status(500).send("Lỗi server: " + err.message);
    }
});

function formatSortCode(sortString) {
    if (!sortString) return ['', '', ''];
    const parts = sortString.split('-').map(p => p.trim());

    // Nếu có 5 phần (GHN: G-300-W-19-A5) -> G | 300-W-19 | A5
    if (parts.length === 5) {
        return [parts[0], `${parts[1]}-${parts[2]}-${parts[3]}`, parts[4]];
    }
    // Nếu có 4 phần (GHN: 30-G-26-A6) -> 30 | G-26 | A6
    if (parts.length === 4) {
        return [parts[0], `${parts[1]}-${parts[2]}`, parts[3]];
    }
    // Nếu có 3 phần (J&T: 620-B25-002) -> Giữ nguyên 1-1-1
    return [parts[0] || '', parts[1] || '', parts[2] || ''];
}

function generateFullHtml(content, isDesktop = false, showCod = 1) {
    const printScript = isDesktop ? `
    <script>
        window.onload = () => {
            window.print();
            window.onafterprint = () => window.parent.postMessage('close-print-frame', '*');
        };
    </script>` : "";

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    @page { size: 80mm 80mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; line-height: 1.1; font-family: "Tahoma", sans-serif; }
    .page-break { height: 79.5mm; width: 80mm; display: flex; justify-content: center; align-items: center; page-break-after: always; overflow: hidden; break-after: page; }
    .page-break:last-child { page-break-after: avoid; break-after: avoid; }
    .label-container { width: 76mm; height: 76mm; border: 2px solid #000; display: flex; flex-direction: column; overflow: hidden; background: #fff; }
    .section-barcode { height: 14mm; border-bottom: 2px solid #000; display: grid; grid-template-columns: 80px 1fr; }
    .logo-box { display: flex; align-items: center; justify-content: center; border-right: 1px solid #000; padding: 3px; }
    .logo-img { max-width: 100%; max-height: 12mm; object-fit: contain; }
    .barcode-box { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1mm 0; }
    .barcode-img { width: 85%; height: 5.5mm; }
    .order-id { font-size: 10px; font-weight: bold; margin-top: 2.5mm; }
    .section-sortline { height: 10mm; border-bottom: 2.5px solid #000; display: grid; grid-template-columns: 1fr 1.5fr 1fr; text-align: center; font-weight: bold; }
    .sort-item { display: flex; align-items: center; justify-content: center; border-right: 1.5px solid #000; font-size: 20px; }
    .sort-item:last-child { border-right: none; }
    .section-addresses { height: 24mm; border-bottom: 1.5px solid #000; padding: 4px; font-size: 11px; display: flex; flex-direction: column; justify-content: space-around; }
    .section-bottom { height: 20mm; display: grid; grid-template-columns: 1fr 22mm; border-bottom: 2.5px solid #000; }
    .note-box { padding: 4px; font-size: 9px; font-weight: bold; text-transform: uppercase; border-right: 1.5px solid #000; display: flex; flex-direction: column; justify-content: flex-start; text-align: left; overflow: hidden; }
    .qr-box { display: flex; align-items: center; justify-content: center; }
    .qr-img { width: 18mm; height: 18mm; }
    .section-cod { flex-grow: 1; padding-left: 8px; display: flex; align-items: center; font-size: 16px; font-weight: bold; }
    ${!showCod ? ".section-cod { display: none !important; }" : ""}
    </style></head><body>${content}${printScript}</body></html>`;
}

async function GetBillJT(orderid) {
    const pkey = 'a773fde3cd06466a83232a9f5df4c17a';
    const apiAccount = '879924327569523968';
    const oderjson = JSON.stringify({
        "customerCode": "251LC20090",
        "password": "7518ED172D9CAF92E13AC20B18227359",
        "txlogisticId": orderid
    });
    const digest = md5ToBase64(oderjson + pkey);
    const url = 'https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/printOrder';
    try {
        const params = new URLSearchParams();
        params.append('bizContent', oderjson);
        const response = await axios.post(url, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'apiAccount': apiAccount,
                'digest': digest,
                'timestamp': Date.now().toString()
            },
            timeout: 3000
        });

        const body = response.data;
        if (body.msg === 'success' && body.data?.base64EncodeContent) {
            const sqlOrder = `INSERT INTO jtbill (billcode, base64) VALUES (?, ?)`;
            await db.promise().query(sqlOrder, [orderid, body.data.base64EncodeContent]);
            console.log(`✅ Đã lấy và lưu Bill J&T cho đơn: ${body.data.billCode}`);
            //console.log(body)// lấy thông tin mã vùng các kiểu
            return true;
        } else {
            console.error(`❌ Lỗi lấy Bill J&T (${orderid}):`, body.msg);
            return false;
        }
    } catch (error) {
        console.error(`❌ Lỗi kết nối lấy Bill J&T:`, error.message);
        return false;
    }
}


app.post('/api/orders/get-jt-print-data', isAuth, async (req, res) => {
    try {
        const { orderCodes } = req.body;

        if (!orderCodes || orderCodes.length === 0) {
            return res.json({ success: false, message: "Không có mã đơn" });
        }

        const [rows] = await db.promise().execute(
            `SELECT billcode, base64 FROM jtbill WHERE billcode IN (${orderCodes.map(() => '?').join(',')})`,
            orderCodes
        );

        if (rows.length === 0) {
            return res.json({ success: false, message: "Không tìm thấy dữ liệu in trong jtbill" });
        }

        const printMap = {};
        rows.forEach(row => {
            printMap[row.billcode] = row.base64;
        });

        res.json({ success: true, printData: printMap });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Lỗi server" });
    }
});

app.post('/api/orders/cancel', isAuth, async (req, res) => {
    const { order_code, provider } = req.body;
    const role = req.app_role;

    try {
        if (provider === "NB") {
            if (role !== 'admin') return res.status(403).json({ success: false, message: "Chỉ Admin mới được hủy đơn nội bộ!" });
            await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
            return res.json({ success: true, message: "Đã hủy đơn nội bộ thành công!" });

        } else if (provider === "Viettel") {
            const [vtpRows] = await db.promise().query('SELECT vtp_token FROM viettel_connect WHERE id = 1');
            const vtpConfig = vtpRows[0];
            if (!vtpConfig?.vtp_token) return res.json({ success: false, message: "Hệ thống chưa cấu hình Token!" });

            const response = await axios.post('https://partner.viettelpost.vn/v2/order/UpdateOrder', {
                "TYPE": 4,
                "ORDER_NUMBER": order_code,
                "NOTE": "Shop hủy đơn"
            }, {
                headers: { 'Content-Type': 'application/json', 'token': vtpConfig.vtp_token },
                timeout: 10000
            });

            if (response.data.status === 200) {
                await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                return res.json({ success: true, message: "Đã hủy đơn thành công trên Viettel" });
            }
            return res.json({ success: false, message: response.data.message || "Viettel từ chối hủy" });

        } else if (provider === "J&T") {
            const pkey = 'a773fde3cd06466a83232a9f5df4c17a';
            const apiAccount = '879924327569523968';
            const oderjson = JSON.stringify({
                "customerCode": "251LC20090",
                "password": "7518ED172D9CAF92E13AC20B18227359",
                "txlogisticId": order_code,
                "reason": "Shop hủy đơn"
            });
            const digest = md5ToBase64(oderjson + pkey);

            const params = new URLSearchParams();
            params.append('bizContent', oderjson);

            const response = await axios.post('https://ylopenapi.jtexpress.vn/webopenplatformapi/api/order/cancelOrder', params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'apiAccount': apiAccount,
                    'digest': digest,
                    'timestamp': Date.now().toString()
                },
                timeout: 10000
            });

            const body = response.data;
            if (body.msg === 'success' || (body.data && body.data.success === 'true')) {
                await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                return res.json({ success: true, message: "Đã hủy đơn thành công trên J&T" });
            } else {
                let mess = body.msg || "Lỗi không xác định";
                if (mess.includes('order status can not be cancel')) mess = 'Không thể hủy đơn đã hủy hoặc đang vận chuyển!';
                return res.json({ success: false, message: "J&T báo: " + mess });
            }
        } else if (provider === "GHN") {
            const ghn_token = '62eca188-17e2-11f1-bf0d-daf9f7d42901';
            const ghn_shopid = '5393581';

            const response = await axios.post('https://online-gateway.ghn.vn/shiip/public-api/v2/switch-status/cancel',
                {
                    "order_codes": [order_code]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'ShopId': ghn_shopid,
                        'Token': ghn_token
                    },
                    timeout: 5000
                });

            const result = response.data;
            if (result && result.code === 200 && result.data && result.data.length > 0) {
                const orderResult = result.data[0];
                if (orderResult.result) {
                    await db.promise().query('UPDATE orders SET status = "cancel" WHERE order_code = ?', [order_code]);
                    return res.json({
                        success: true,
                        message: `Đã hủy đơn ${order_code} thành công trên GHN`
                    });
                } else {
                    return res.json({
                        success: false,
                        message: "GHN báo lỗi: " + (orderResult.message || "Không thể hủy đơn")
                    });
                }
            } else {
                return res.json({
                    success: false,
                    message: "Lỗi kết nối API GHN: " + (result.message || "Unknown Error")
                });
            }
        }
    } catch (err) {
        console.error("Lỗi Cancel Order:", err.message);
        return res.status(500).json({ success: false, message: "Lỗi hệ thống khi hủy đơn!" });
    }
});

app.get('/api/viettel/trace', async (req, res) => {
    const username = req.app_user;
    if (!username) return res.status(401).json({ success: false, msg: "Chưa đăng nhập" });

    const { billCode } = req.query;
    if (!billCode) return res.json({ success: false, msg: "Thiếu mã vận đơn" });

    try {
        const [tokenRows] = await db.promise().query(
            "SELECT vtp_token FROM viettel_connect LIMIT 1", [username]
        );

        if (!tokenRows.length || !tokenRows[0].vtp_token) {
            return res.json({ success: false, msg: "Chưa cấu hình Token Viettel!" });
        }

        const vtpToken = tokenRows[0].vtp_token;
        const queryUrl = `https://partner.viettelpost.vn/v2/order/detail-v2?o=${billCode}`;

        const response = await axios.get(encodeURI(queryUrl), {
            headers: { 'Content-Type': 'application/json', 'token': vtpToken },
            timeout: 3000
        });

        const body = response.data;
        if (body.error === true) return res.json({ success: false, msg: 'Token Viettel lỗi/hết hạn' });

        let status = body.data ? body.data.ORDER_STATUS : 100;
        const statusMap = {
            100: 'pending', 101: 'cancel', 102: 'pending', 105: 'picked_up',
            107: 'cancel', 300: 'Đang vận chuyển', 501: 'Thành công', 504: 'Đã trả hàng'
        };
        let text = statusMap[status] || 'Đang xử lý';

        if (body.data) {
            await db.promise().query(
                'UPDATE orders SET status=?, price=? WHERE order_code=?',
                [text, body.data.MONEY_COLLECTION, body.data.ORDER_NUMBER]
            );
        }

        return res.json({
            success: true,
            code: '1',
            data: { status: text, note: body.data ? `COD: ${body.data.MONEY_COLLECTION.toLocaleString('vi-VN')} đ` : '', details: [] }
        });

    } catch (err) {
        console.error("Lỗi Viettel:", err.message);
        return res.json({ success: false, msg: "Lỗi kết nối Viettel Post" });
    }
});

app.get('/api/orders/track-jt/:billCode', async (req, res) => {
    try {
        const { billCode } = req.params;
        const [orderInfo] = await db.promise().execute(
            `SELECT status, provider FROM orders WHERE realjtbillcode = ? OR order_code = ? LIMIT 1`,
            [billCode, billCode]
        );
        const [trackingData] = await db.promise().execute(
            `SELECT * FROM jtwaybill WHERE billcode = ? ORDER BY id DESC`,
            [billCode]
        );
        res.json({
            success: true,
            currentStatus: orderInfo[0]?.status || 'N/A',
            trackingData: trackingData
        });
    } catch (error) {
        console.error("Lỗi lấy hành trình:", error);
        res.status(500).json({ success: false });
    }
});

app.post('/admin/update-user-price', isManager, async (req, res) => {
    if (req.app_role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Bạn không có quyền thay đổi giá cước!' });
    }

    const { userId, basePrice, stepPrice, baseWeight } = req.body;

    try {
        await db.promise().query(
            'UPDATE users SET base_price = ?, step_price = ?, base_weight = ? WHERE id = ?',
            [basePrice, stepPrice, baseWeight, userId]
        );

        await db.promise().query(
            'INSERT INTO logs (performed_by, action) VALUES (?, ?)',
            [req.app_user, `Cập nhật giá cước cho User ID ${userId}: KG gốc ${baseWeight}, Gốc ${basePrice}, Bước ${stepPrice}`]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi cơ sở dữ liệu" });
    }
});

app.post('/customers/delete/:id', isAuth, async (req, res) => {
    const customerId = req.params.id;

    try {
        const sql = `DELETE FROM customers WHERE id = ?`;
        await db.promise().query(sql, [customerId]);

        res.json({ success: true, message: "Đã xóa khách hàng thành công!" });
    } catch (err) {
        console.error("Lỗi Delete Customer:", err);
        res.json({ success: false, message: "Không thể xóa khách hàng này (có thể do đang có đơn hàng liên quan)." });
    }
});

app.post('/admin/import-customers', isAdmin, async (req, res) => {
    const { customers, targetUserId } = req.body;
    if (!customers || !targetUserId) return res.json({ success: false });

    try {
        const values = customers.map(c => [c.name, c.phone, c.address, targetUserId]);

        const sql = "INSERT IGNORE INTO customers (name, phone, address, user_id) VALUES ?";
        const [result] = await db.promise().query(sql, [values]);

        res.json({
            success: true,
            count: result.affectedRows,
            ignored: customers.length - result.affectedRows
        });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Lỗi Database' });
    }
});

app.post('/api/admin/update-user-jt', isAdmin, async (req, res) => {
    const {
        target_user_id, jt_shopname, jt_sdt,
        jt_shopaddress, jt_shop_prov, jt_shop_district, jt_shop_ward
    } = req.body;
    if (!target_user_id || !jt_shopname || !jt_sdt || !jt_shopaddress || !jt_shop_prov || !jt_shop_district || !jt_shop_ward) {
        return res.status(400).json({ success: false, message: "Thiếu thông tin!" });
    }

    try {
        const sql = `UPDATE users SET jt_shopname=?, jt_sdt=?, jt_shopaddress=?, jt_shop_prov=?, jt_shop_district=?, jt_shop_ward=? WHERE id=?`;
        const params = [jt_shopname, jt_sdt, jt_shopaddress, jt_shop_prov, jt_shop_district, jt_shop_ward, target_user_id];
        const result = await db.promise().execute(sql, params);
        const header = Array.isArray(result) ? result[0] : result;

        if (header && (header.affectedRows > 0 || header.changedRows >= 0)) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "Không có thay đổi nào được thực hiện." });
        }
    } catch (err) {
        console.error("Lỗi DB chi tiết:", err);
        res.status(500).json({ success: false, message: "Lỗi hệ thống: " + err.message });
    }
});

app.get('/api/orders/export-excel', isAuth, async (req, res) => {
    try {
        const { startDate, endDate, userId, dateType, status, search, provider } = req.query;
        const actualRole = req.app_role;  // lấy từ session, không tin query string
        const actualUser = req.app_user;
        const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';

        let conditions = [];
        let exportParams = [];

        if (actualRole === 'admin') {
            // Admin: không filter user_id, join thêm shopname
        } else {
            // Shop chỉ được xuất đơn của chính mình
            const [selfRows] = await db.promise().query('SELECT id FROM users WHERE username = ?', [actualUser]);
            const selfId = selfRows[0]?.id;
            conditions.push('o.user_id = ?');
            exportParams.push(selfId);
        }

        if (startDate && endDate) {
            conditions.push(`DATE(o.${dateField}) BETWEEN ? AND ?`);
            exportParams.push(startDate, endDate);
        }

        if (status) {
            if (status === 'delivering') conditions.push("o.status IN ('picked_up', 'delivering')");
            else if (status === 'returned') conditions.push("o.status IN ('returning', 'returned')");
            else { conditions.push('o.status = ?'); exportParams.push(status); }
        }

        if (search) {
            const codes = search.split(',').map(s => s.trim()).filter(Boolean);
            if (codes.length > 1) {
                const placeholders = codes.map(() => '?').join(',');
                conditions.push(`(o.order_code IN (${placeholders}) OR o.realjtbillcode IN (${placeholders}))`);
                exportParams.push(...codes, ...codes);
            } else if (search.length <= 6) {
                conditions.push('o.customer_phone LIKE ?');
                exportParams.push(`%${search}`);
            } else {
                conditions.push('(o.order_code LIKE ? OR o.realjtbillcode LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
                const s = `%${search}%`;
                exportParams.push(s, s, s, s);
            }
        }

        if (provider) {
            conditions.push('o.provider = ?');
            exportParams.push(provider);
        }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const exportQuery = `SELECT o.*, u.shopname, u.jt_sdt FROM orders o LEFT JOIN users u ON o.user_id = u.id ${whereClause} ORDER BY o.created_at DESC`;

        const [orders] = await db.promise().query(exportQuery, exportParams);

        const statusLabel = {
            pending: 'Chờ lấy hàng',
            cancel: 'Đã hủy đơn',
            picked_up: 'Đã lấy hàng',
            delivering: 'Đang vận chuyển',
            out_for_delivery: 'Đang giao hàng',
            completed: 'Thành công',
            returning: 'Đang hoàn',
            returned: 'Đã hoàn hàng',
            issue: 'Kiện vấn đề'
        };

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Tất cả đơn hàng');

        worksheet.columns = [
            { header: 'Mã vận đơn', key: 'bill_code', width: 22 },
            { header: 'ĐVVC', key: 'provider', width: 12 },
            { header: 'Tên shop', key: 'shopname', width: 25 },
            { header: 'SĐT shop', key: 'shop_phone', width: 15 },
            { header: 'Tên khách hàng', key: 'customer_name', width: 25 },
            { header: 'SĐT khách', key: 'customer_phone', width: 15 },
            { header: 'Địa chỉ khách', key: 'customer_address', width: 50 },
            { header: 'Tên sản phẩm', key: 'product_name', width: 25 },
            { header: 'COD', key: 'price', width: 15 },
            { header: 'KG', key: 'weight', width: 10 },
            { header: 'Trạng thái', key: 'status', width: 20 },
            { header: 'Ngày tạo đơn', key: 'created_at', width: 20 },
            { header: 'Ngày lấy hàng', key: 'pickup_date', width: 20 },
            { header: 'Phí nội bộ', key: 'internal_fee', width: 15 },
            { header: 'SL bản in', key: 'is_printed', width: 12 }
        ];

        orders.forEach(order => {
            // Đơn NB lưu mã ở order_code, các đơn khác lưu ở realjtbillcode (hoặc order_code với GHN/Viettel)
            const billCode = order.realjtbillcode || order.order_code || '';
            worksheet.addRow({
                bill_code: billCode,
                provider: order.provider || '',
                shopname: order.shopname || '',
                shop_phone: order.jt_sdt || '',
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_address: order.customer_address,
                product_name: order.product_name,
                price: order.price != null ? Math.round(Number(order.price)) : '',
                weight: order.weight,
                status: statusLabel[order.status] || order.status,
                created_at: new Date(order.created_at).toLocaleString('vi-VN'),
                pickup_date: order.pickup_date ? new Date(order.pickup_date).toLocaleString('vi-VN') : '',
                internal_fee: order.internal_fee,
                is_printed: order.is_printed || 0
            });
        });

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Export_Orders_${startDate}_${endDate}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Lỗi xuất Excel:", error);
        res.status(500).send("Không thể xuất file Excel.");
    }
});

app.post('/api/profile/notes/add', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false, message: "Hết phiên làm việc" });

    const { content } = req.body;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false, message: "User không tồn tại" });

        const userId = users[0].id;
        await db.promise().query("INSERT INTO order_notes (user_id, content) VALUES (?, ?)", [userId, content]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi hệ thống" });
    }
});

app.post('/api/profile/products/add', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false, message: "Hết phiên làm việc" });

    const { content } = req.body;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false, message: "User không tồn tại" });

        const userId = users[0].id;
        await db.promise().query("INSERT INTO order_products (user_id, product_name) VALUES (?, ?)", [userId, content]);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Lỗi hệ thống" });
    }
});

app.post('/api/profile/notes/delete/:id', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });

    const noteId = req.params.id;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false });
        const userId = users[0].id;

        const [result] = await db.promise().query(
            "DELETE FROM order_notes WHERE id = ? AND user_id = ?",
            [noteId, userId]
        );

        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Bạn không có quyền xóa ghi chú này hoặc ghi chú không tồn tại" });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

app.post('/api/profile/products/delete/:id', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });

    const noteId = req.params.id;
    const username = req.app_user;

    try {
        const [users] = await db.promise().query("SELECT id FROM users WHERE username = ?", [username]);
        if (users.length === 0) return res.json({ success: false });
        const userId = users[0].id;

        const [result] = await db.promise().query(
            "DELETE FROM order_products WHERE id = ? AND user_id = ?",
            [noteId, userId]
        );

        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Bạn không có quyền xóa sản phẩm này" });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

app.post('/api/profile/update-jt', async (req, res) => {
    if (!req.app_user) {
        return res.status(401).json({ success: false });
    }

    const { jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov } = req.body;
    const username = req.app_user;

    if (!jt_sdt || !jt_shopname || !jt_shopaddress || !jt_shop_ward || !jt_shop_district || !jt_shop_prov) {
        return res.json({ success: false, message: "Thiếu thông tin. Kiểm tra lại!" });
    }

    try {
        await db.promise().query(
            `UPDATE users SET 
                jt_sdt = ?, jt_shopname = ?, jt_shopaddress = ?, 
                jt_shop_ward = ?, jt_shop_district = ?, jt_shop_prov = ? 
            WHERE username = ?`,
            [jt_sdt, jt_shopname, jt_shopaddress, jt_shop_ward, jt_shop_district, jt_shop_prov, username]
        );
        return res.json({ success: true });

    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Lỗi Database" });
    }
});

app.get('/api/profile/stats', isAuth, async (req, res) => {
    const username = req.app_user;
    const days = parseInt(req.query.days) || 1;
    const allowed = [1, 3, 7, 15, 30];
    if (!allowed.includes(days)) return res.status(400).json({ success: false, message: 'Khoảng thời gian không hợp lệ' });

    try {
        const [rows] = await db.promise().query(
            `SELECT
                COUNT(*) as total,
                SUM(price) as total_revenue,
                SUM(CASE WHEN o.status = 'pending'   THEN 1 ELSE 0 END) as cnt_pending,
                SUM(CASE WHEN o.status = 'pending'   THEN price ELSE 0 END) as rev_pending,
                SUM(CASE WHEN o.status = 'picked_up' THEN 1 ELSE 0 END) as cnt_picked_up,
                SUM(CASE WHEN o.status = 'picked_up' THEN price ELSE 0 END) as rev_picked_up,
                SUM(CASE WHEN o.status = 'delivering' THEN 1 ELSE 0 END) as cnt_delivering,
                SUM(CASE WHEN o.status = 'delivering' THEN price ELSE 0 END) as rev_delivering,
                SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as cnt_completed,
                SUM(CASE WHEN o.status = 'completed' THEN price ELSE 0 END) as rev_completed,
                SUM(CASE WHEN o.status = 'returned'  THEN 1 ELSE 0 END) as cnt_returned,
                SUM(CASE WHEN o.status = 'returned'  THEN price ELSE 0 END) as rev_returned,
                SUM(CASE WHEN o.status = 'issue'     THEN 1 ELSE 0 END) as cnt_issue,
                SUM(CASE WHEN o.status = 'issue'     THEN price ELSE 0 END) as rev_issue,
                SUM(CASE WHEN o.status = 'cancel'    THEN 1 ELSE 0 END) as cnt_cancel,
                SUM(CASE WHEN o.status = 'cancel'    THEN price ELSE 0 END) as rev_cancel
             FROM orders o
             JOIN users u ON o.user_id = u.id
             WHERE u.username = ?
             AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [username, days]
        );
        return res.json({ success: true, stats: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

app.post('/api/profile/toggle-cod', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });
    const { show_cod } = req.body;
    try {
        await db.promise().query(
            `UPDATE users SET show_cod = ? WHERE username = ?`,
            [show_cod ? 1 : 0, req.app_user]
        );
        return res.json({ success: true, show_cod: show_cod ? 1 : 0 });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Lỗi Database' });
    }
});

app.post('/api/profile/toggle-socket-print', async (req, res) => {
    if (!req.app_user) return res.status(401).json({ success: false });
    const { use_socket_print } = req.body;
    try {
        await db.promise().query(
            `UPDATE users SET use_socket_print = ? WHERE username = ?`,
            [use_socket_print ? 1 : 0, req.app_user]
        );
        return res.json({ success: true, use_socket_print: use_socket_print ? 1 : 0 });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: 'Lỗi Database' });
    }
});

app.get('/api/address/provinces', async (req, res) => {
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT prov FROM jtaddress ORDER BY prov");
        res.json(rows.map(r => r.prov));
    } catch (err) { res.status(500).json([]); }
});


app.get('/api/address/districts', async (req, res) => {
    const { prov } = req.query;
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT district FROM jtaddress WHERE prov = ? ORDER BY district", [prov]);
        res.json(rows.map(r => r.district));
    } catch (err) { res.status(500).json([]); }
});


app.get('/api/address/wards', async (req, res) => {
    const { prov, district } = req.query;
    try {
        const [rows] = await db.promise().query("SELECT DISTINCT ward FROM jtaddress WHERE prov = ? AND district = ? ORDER BY ward", [prov, district]);
        res.json(rows.map(r => r.ward));
    } catch (err) { res.status(500).json([]); }
});

// Kiểm tra trạng thái kết nối App C# của user
app.post('/api/printer-status', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Thiếu userId' });
    const userRoom = `USER_ROOM_${userId}`;
    const clients = io.sockets.adapter.rooms.get(userRoom);
    const online = !!(clients && clients.size > 0);
    res.json({ success: true, online, clients: online ? clients.size : 0 });
});

// In tem qua socket — tạo PDF buffer rồi đẩy base64 về App C# qua socket
app.post('/api/print-orders-socket', async (req, res) => {
    const BATCH_SIZE = 10; // Mỗi lần emit tối đa 10 tem (~800KB base64)
    const BATCH_DELAY = 300; // ms delay giữa các batch để App C# kịp xử lý

    try {
        const { ids, userId } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Danh sách mã đơn không hợp lệ' });
        }
        if (!userId) {
            return res.status(400).json({ success: false, message: 'Thiếu userId' });
        }

        // Kiểm tra App C# có online không
        const userRoom = `USER_ROOM_${userId}`;
        const clients = io.sockets.adapter.rooms.get(userRoom);
        if (!clients || clients.size === 0) {
            return res.status(404).json({ success: false, message: 'App C# của bạn chưa Online. Vui lòng mở ứng dụng trên máy tính!' });
        }

        const orders = await queryOrdersByIds(ids);
        if (orders.length === 0) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng nào' });
        }

        const [users] = await db.promise().query('SELECT * FROM users WHERE id = ?', [orders[0].user_id]);
        const user = users[0] || {};
        const showCod = user.show_cod !== undefined ? user.show_cod : 1;
        const printerConfig = {
            printerName: user.printer_name || "Xprinter XP-N160II",
            widthMm: 80,
            heightMm: 80,
            marginTopPx: 0
        };

        const totalBatches = Math.ceil(orders.length / BATCH_SIZE);

        // Trả response ngay, render + emit batch chạy nền
        res.json({
            success: true,
            message: `Đang xử lý ${orders.length} tem (${totalBatches} batch × ${BATCH_SIZE})...`,
            total: orders.length,
            batches: totalBatches
        });

        // Chạy nền: render từng batch bằng pdfkit (không cần Puppeteer)
        (async () => {
            for (let i = 0; i < orders.length; i += BATCH_SIZE) {
                const batch = orders.slice(i, i + BATCH_SIZE);
                const batchIndex = Math.floor(i / BATCH_SIZE) + 1;

                try {
                    const pdfBuffer = await renderLabelsToPdfBuffer(batch, user, showCod);

                    io.to(userRoom).emit("print-now", {
                        base64: pdfBuffer.toString('base64'),
                        config: printerConfig,
                        batchInfo: { current: batchIndex, total: totalBatches, count: batch.length }
                    });

                    console.log(`[Socket Print] User ${userId} — Batch ${batchIndex}/${totalBatches} (${batch.length} tem) — ${clients.size} máy nhận`);
                } catch (batchErr) {
                    console.error(`[Socket Print] Lỗi batch ${batchIndex}:`, batchErr.message);
                    io.to(userRoom).emit("print-error", {
                        message: `Lỗi batch ${batchIndex}/${totalBatches}: ${batchErr.message}`
                    });
                }

                if (i + BATCH_SIZE < orders.length) {
                    await new Promise(r => setTimeout(r, BATCH_DELAY));
                }
            }
            console.log(`[Socket Print] User ${userId} — Hoàn tất ${orders.length} tem / ${totalBatches} batch`);
        })();

    } catch (err) {
        console.error('[Socket Print Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
        }
    }
});

app.post('/api/print-order', (req, res) => {
    const { userId, pdfBase64, printerName } = req.body;

    if (!userId || !pdfBase64) {
        return res.status(400).json({ success: false, message: "Thiếu userId hoặc dữ liệu Base64" });
    }

    const userRoom = `USER_ROOM_${userId}`;

    const clients = io.sockets.adapter.rooms.get(userRoom);
    const isOnline = clients && clients.size > 0;

    if (isOnline) {
        io.to(userRoom).emit("print-now", {
            base64: pdfBase64,
            config: {
                printerName: printerName || "Xprinter XP-N160II",
                widthMm: 75,
                heightMm: 82,
                marginTopPx: -5
            }
        });

        //console.log(`[Lệnh in] Đã đẩy xuống User ${userId} (${clients.size} máy nhận)`);
        res.json({ success: true, message: "Đã gửi lệnh in" });
    } else {
        console.log(`[Lệnh in] Thất bại. User ${userId} chưa bật App C#`);
        res.status(404).json({ success: false, message: "Máy in của User chưa Online" });
    }
});

app.get('/admin/export-orders', isManager, async (req, res) => {
    try {
        const { userId, start, end, dateType } = req.query;
        const dateField = dateType === 'pickup' ? 'pickup_date' : 'created_at';
        const query = `
            SELECT * FROM orders 
            WHERE user_id = ? 
            AND ${dateField} >= ? AND ${dateField} <= ?
            ORDER BY created_at DESC
        `;
        const params = [userId, `${start} 00:00:00`, `${end} 23:59:59`];
        const [orders] = await db.promise().execute(query, params);

        if (orders.length === 0) {
            return res.status(404).json({ success: false, message: "Không có dữ liệu để xuất!" });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Danh sách vận đơn');

        worksheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Mã nội bộ', key: 'order_code', width: 20 },
            { header: 'Mã J&T', key: 'realjt_billcode', width: 20 },
            { header: 'ĐVVC', key: 'provider', width: 15 },
            { header: 'Ngày tạo', key: 'created_at', width: 20 },
            { header: 'Ngày lấy hàng', key: 'pickup_date', width: 20 },
            { header: 'Khách hàng', key: 'customer_name', width: 20 },
            { header: 'SĐT', key: 'customer_phone', width: 15 },
            { header: 'Địa chỉ', key: 'customer_address', width: 35 },
            { header: 'Sản phẩm', key: 'product_name', width: 25 },
            { header: 'KL (kg)', key: 'weight', width: 12 },
            { header: 'COD', key: 'price', width: 12 },
            { header: 'COD gốc', key: 'original_cod', width: 12 },
            { header: 'Cước', key: 'internal_fee', width: 12 },
            { header: 'Trạng thái', key: 'status', width: 15 },
            { header: 'SL bản in', key: 'is_printed', width: 12 }
        ];

        orders.forEach(order => {
            const row = worksheet.addRow({
                id: order.id,
                order_code: order.order_code,
                realjt_billcode: order.realjtbillcode,
                provider: order.provider,
                created_at: new Date(order.created_at).toLocaleString('vi-VN'),
                pickup_date: order.pickup_date ? new Date(order.pickup_date).toLocaleString('vi-VN') : '',
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_address: order.customer_address,
                product_name: order.product_name,
                weight: order.weight,
                price: Number(order.price),
                original_cod: Number(order.original_cod),
                internal_fee: Number(order.internal_fee),
                status: order.status,
                is_printed: order.is_printed || 0
            });

            row.getCell('customer_address').alignment = { wrapText: true, vertical: 'middle' };
            row.getCell('product_name').alignment = { wrapText: true, vertical: 'middle' };
        });

        const headerRow = worksheet.getRow(1);
        worksheet.columns.forEach((col, index) => {
            const cell = headerRow.getCell(index + 1);

            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '4F81BD' }
            };
            cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 12 };

            cell.alignment = { vertical: 'middle', horizontal: 'center' };

            cell.border = {
                top: { style: 'thin' },
                left: { style: 'thin' },
                bottom: { style: 'thin' },
                right: { style: 'thin' }
            };
        });

        ['price', 'original_cod', 'internal_fee'].forEach(key => {
            worksheet.getColumn(key).numFmt = '#,##0';
        });

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=Van_Don_${userId}.xlsx`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Lỗi xuất Excel:", error);
        res.status(500).send("Lỗi server khi xuất file");
    }
});

app.get('/api/admin/get-order', isManager, async (req, res) => {
    let { code } = req.query;
    if (!code) return res.status(400).json({ success: false, message: "Thiếu mã đơn" });

    try {
        const codeArray = code.split(',').map(item => item.trim()).filter(item => item !== "");

        let sql;
        let params;

        if (codeArray.length === 1) {
            const searchTerm = `%${codeArray[0]}%`;
            sql = "SELECT * FROM orders WHERE realjtbillcode LIKE ? OR order_code LIKE ? LIMIT 20";
            params = [searchTerm, searchTerm];
        } else {
            const placeholders = codeArray.map(() => '?').join(',');
            sql = `SELECT * FROM orders 
                   WHERE realjtbillcode IN (${placeholders}) 
                      OR order_code IN (${placeholders}) 
                   LIMIT 20`;
            params = [...codeArray, ...codeArray];
        }

        const [rows] = await db.promise().query(sql, params);

        if (rows && rows.length > 0) {
            res.json({ success: true, orders: rows });
        } else {
            res.json({ success: false, message: "Không tìm thấy vận đơn nào khớp!" });
        }
    } catch (err) {
        console.error("Lỗi search đơn:", err);
        res.status(500).json({ success: false, message: "Lỗi hệ thống: " + err.message });
    }
});

app.post('/api/admin/update-order', isManager, async (req, res) => {
    const {
        id, customer_name, customer_phone, customer_address,
        jt_prov, jt_district, jt_ward, price, kg, custId,
        status
    } = req.body;

    const isAdmin = req.app_role === 'admin';

    try {
        const [existingRows] = await db.promise().query('SELECT * FROM orders WHERE id = ?', [id]);
        if (existingRows.length === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        const existingOrder = existingRows[0];

        if (!isAdmin && (existingOrder.status === 'completed' || existingOrder.status === 'returned')) {
            return res.status(403).json({ success: false, message: 'Chỉ Admin mới được sửa đơn đã Hoàn thành hoặc Đã hoàn!' });
        }

        const [userRows] = await db.promise().query('SELECT * FROM users WHERE id = ?', [custId]);
        const user = userRows[0];

        const [actorRows] = await db.promise().query('SELECT username, shopname FROM users WHERE username = ?', [req.app_user]);
        const actor = actorRows[0] || {};

        const inputWeight = parseFloat(kg) || 0.5;
        const uBasePrice = Number(user.base_price) || 20000;
        const uStepPrice = Number(user.step_price) || 5000;
        const uBaseWeight = Number(user.base_weight) || 2;

        let calculatedFee = uBasePrice;

        const billableWeight = Math.ceil(inputWeight);

        if (billableWeight > uBaseWeight && uStepPrice > 0) {
            const extraKg = billableWeight - uBaseWeight;
            calculatedFee += extraKg * uStepPrice;
        }

        const statusMap = {
            'Chờ lấy hàng': 'pending',
            'Đang vận chuyển': 'picked_up',
            'Đang giao hàng': 'out_for_delivery',
            'Hoàn thành': 'completed',
            'Đã hoàn': 'returned',
        };

        let dbStatus = status ? (statusMap[status] || null) : null;

        // Manager không được set completed/returned
        if (!isAdmin && (dbStatus === 'completed' || dbStatus === 'returned')) {
            return res.status(403).json({ success: false, message: 'Chỉ Admin mới được set trạng thái Hoàn thành hoặc Đã hoàn!' });
        }

        // Lấy COD hiện tại nếu là manager
        let finalPrice = price;
        if (!isAdmin) {
            finalPrice = existingOrder.price;
        }

        let sql = `
            UPDATE orders SET 
                customer_name = ?, customer_phone = ?, customer_address = ?, 
                jt_prov = ?, jt_district = ?, jt_ward = ?, price = ?, weight = ?, internal_fee = ?
        `;
        const params = [
            customer_name, customer_phone, customer_address,
            jt_prov, jt_district, jt_ward, finalPrice, kg, calculatedFee
        ];

        if (dbStatus) {
            sql += `, status = ?`;
            params.push(dbStatus);
            if (dbStatus === 'picked_up' && existingOrder.status === 'pending') {
                sql += `, pickup_date = NOW()`;
            }
        }

        sql += ` WHERE id = ?`;
        params.push(id);

        await db.promise().execute(sql, params);

        if (existingOrder.provider === 'NB' && dbStatus) {
            const statusNameMap = {
                'pending': 'Chờ lấy hàng',
                'picked_up': 'Đã lấy hàng',
                'out_for_delivery': 'Đang giao hàng',
                'completed': 'Giao thành công',
                'returned': 'Đã hoàn hàng',
            };
            const scanTypeName = statusNameMap[dbStatus] || status;
            const billcode = existingOrder.realjtbillcode || existingOrder.order_code;
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

            await db.promise().execute(
                `INSERT INTO jtwaybill 
                    (billcode, scanbycode, scanbycontact, scanbyname, scanward, scancity, scanprov, scanpost, scantime, scantypename, issuename)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    billcode,
                    actor.username || req.app_user,   // scanbycode
                    actor.username || req.app_user,   // scanbycontact (username thay SĐT)
                    actor.shopname || req.app_user,   // scanbyname (shopname)
                    'Biên Hòa',                        // scanward
                    'Biên Hòa',                        // scancity
                    'Đồng Nai',                        // scanprov
                    'NB-TVSHIP-BH',                    // scanpost
                    now,                               // scantime
                    scanTypeName,                      // scantypename
                    null                               // issuename
                ]
            );
        }

        res.json({ success: true, message: 'Cập nhật đơn hàng thành công!' });
    } catch (err) {
        console.error('Lỗi update order:', err);
        res.status(500).json({ success: false, message: 'Lỗi DB: ' + err.message });
    }
});

app.post('/api/orders/mark-printed', isAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Không có mã đơn nào' });
        }

        const placeholders = ids.map(() => '?').join(',');
        const sql = `
            UPDATE orders
            SET is_printed = is_printed + 1,
                printed_at  = COALESCE(printed_at, NOW())
            WHERE order_code IN (${placeholders})
               OR realjtbillcode IN (${placeholders})
        `;
        const [result] = await db.promise().query(sql, [...ids, ...ids]);

        return res.json({ success: true, updated: result.affectedRows });
    } catch (err) {
        console.error('[mark-printed] Lỗi:', err.message);
        return res.status(500).json({ success: false, message: 'Lỗi hệ thống' });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('jwt_token');
    res.clearCookie('rememberUser');
    res.redirect('/login');
});
httpServer.listen(80, () => {
    console.log('HTTP: 80');
});

httpsServer.listen(443, () => {
    console.log('HTTPS: 443');
});
//app.listen(3000, () => console.log('PushOrder System: http://localhost:3000'));