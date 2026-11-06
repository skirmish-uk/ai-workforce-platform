#!/bin/bash
# AI Workforce Platform - Development Server Manager

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$PROJECT_ROOT/apps/web"
LOG_FILE="/tmp/next-dev.log"
PID_FILE="/tmp/next-dev.pid"

export PORT=3000
export NEXTAUTH_SECRET="dev-secret-change-in-production"
export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_workforce?schema=public"

cd "$WEB_DIR"

case "$1" in
    start)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "Server already running (PID: $(cat "$PID_FILE"))"
            exit 0
        fi
        
        echo "Starting development server..."
        nohup npm run dev > "$LOG_FILE" 2>&1 &
        PID=$!
        echo $PID > "$PID_FILE"
        
        echo "Waiting for server to be ready..."
        for i in {1..30}; do
            if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000 2>/dev/null | grep -q "200"; then
                echo "Server ready at http://127.0.0.1:3000"
                echo "Dashboard: http://127.0.0.1:3000/dashboard"
                echo "Sign in: http://127.0.0.1:3000/auth/signin"
                exit 0
            fi
            sleep 1
        done
        
        echo "Server failed to start within 30 seconds"
        cat "$LOG_FILE"
        exit 1
        ;;
    
    stop)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "Stopping server (PID: $(cat "$PID_FILE"))..."
            kill -TERM "$(cat "$PID_FILE")" 2>/dev/null
            sleep 2
            if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
                kill -9 "$(cat "$PID_FILE")" 2>/dev/null
            fi
            rm -f "$PID_FILE"
            echo "Server stopped"
        else
            echo "Server not running"
        fi
        ;;
    
    restart)
        "$BASH_SOURCE" stop
        sleep 2
        "$BASH_SOURCE" start
        ;;
    
    logs)
        if [ -f "$LOG_FILE" ]; then
            tail -f "$LOG_FILE"
        else
            echo "No log file found"
        fi
        ;;
    
    status)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "Server running (PID: $(cat "$PID_FILE"))"
        else
            echo "Server not running"
        fi
        ;;
    
    *)
        echo "Usage: $0 {start|stop|restart|logs|status}"
        exit 1
        ;;
esac