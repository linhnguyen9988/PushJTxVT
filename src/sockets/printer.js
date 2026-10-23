const bcrypt = require('bcrypt');
const { io } = require('../core/server');
const { db } = require('../lib/db');

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
        for (const room of socket.rooms) {
            if (room.startsWith("USER_ROOM_")) {
                socket.leave(room);
                console.log(`[Socket] ${username} rời room ${room}`);
            }
        }
    });

    socket.on("disconnect", (reason) => {
        console.log(`[Socket] Ngắt kết nối: ${socket.id} — lý do: ${reason}`);
        for (const room of socket.rooms) {
            if (room.startsWith("USER_ROOM_")) {
                const size = io.sockets.adapter.rooms.get(room)?.size ?? 0;
                console.log(`[Socket] Room ${room} còn ${size} client`);
            }
        }
    });
});
