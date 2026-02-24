#!/bin/bash

# Vexa Bot Interaction Script

# --- Configuration ---
# Default Vexa API base URL and Admin API URL will be constructed using ports from .env
# Default ports if not found in .env
DEFAULT_API_GATEWAY_HOST_PORT="8056"
DEFAULT_ADMIN_API_HOST_PORT="8057"

API_GATEWAY_HOST_PORT=""
ADMIN_API_HOST_PORT=""

# --- Helper Functions ---
echo_error() {
    echo -e "\033[0;31mERROR: $1\033[0m" >&2
}

echo_info() {
    echo -e "\033[0;32mINFO: $1\033[0m"
}

echo_warn() {
    echo -e "\033[0;33mWARN: $1\033[0m"
}

# --- Check for dependencies ---
if ! command -v curl &> /dev/null; then
    echo_error "curl is not installed. Please install it to run this script."
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo_error "python3 is not installed. Please install Python 3 to use real-time transcription."
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo_warn "jq is not installed. JSON parsing will be basic and less robust."
    echo_warn "It is highly recommended to install jq: sudo apt-get install jq (or similar for your OS)"
    JQ_INSTALLED=false
else
    JQ_INSTALLED=true
fi

# --- Read .env file for ADMIN_API_TOKEN and HOST PORTS ---
ADMIN_TOKEN=""
if [ -f ".env" ]; then
    echo_info "Reading configuration from .env file..."
    # Source .env file if it exists and extract ADMIN_API_TOKEN
    ADMIN_TOKEN_FROM_ENV=$(grep -E '^[[:space:]]*ADMIN_API_TOKEN=' .env | head -n 1 | cut -d '=' -f2-)
    if [[ -n "$ADMIN_TOKEN_FROM_ENV" ]]; then
        ADMIN_TOKEN=$(echo "$ADMIN_TOKEN_FROM_ENV" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        if [[ -n "$ADMIN_TOKEN" ]]; then
            echo_info "Using Admin API Token from .env file."
        else
            echo_warn "Found ADMIN_API_TOKEN in .env but it appears to be empty after parsing."
        fi
    else
        echo_warn "ADMIN_API_TOKEN not found in .env file or line is malformed."
    fi

    # Extract API_GATEWAY_HOST_PORT
    TEMP_API_PORT=$(grep -E '^[[:space:]]*API_GATEWAY_HOST_PORT=' .env | head -n 1 | cut -d '=' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    if [[ -n "$TEMP_API_PORT" ]]; then
        API_GATEWAY_HOST_PORT=$TEMP_API_PORT
        echo_info "Using API_GATEWAY_HOST_PORT from .env: $API_GATEWAY_HOST_PORT"
    else
        echo_warn "API_GATEWAY_HOST_PORT not found in .env or empty."
    fi

    # Extract ADMIN_API_HOST_PORT
    TEMP_ADMIN_PORT=$(grep -E '^[[:space:]]*ADMIN_API_HOST_PORT=' .env | head -n 1 | cut -d '=' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    if [[ -n "$TEMP_ADMIN_PORT" ]]; then
        ADMIN_API_HOST_PORT=$TEMP_ADMIN_PORT
        echo_info "Using ADMIN_API_HOST_PORT from .env: $ADMIN_API_HOST_PORT"
    else
        echo_warn "ADMIN_API_HOST_PORT not found in .env or empty."
    fi
else
    echo_warn ".env file not found. Will prompt for Admin Token and use default ports."
fi

# Set defaults if still empty
if [[ -z "$API_GATEWAY_HOST_PORT" ]]; then
    echo_warn "API_GATEWAY_HOST_PORT not set, using default: $DEFAULT_API_GATEWAY_HOST_PORT"
    API_GATEWAY_HOST_PORT=$DEFAULT_API_GATEWAY_HOST_PORT
fi
if [[ -z "$ADMIN_API_HOST_PORT" ]]; then
    echo_warn "ADMIN_API_HOST_PORT not set, using default: $DEFAULT_ADMIN_API_HOST_PORT"
    ADMIN_API_HOST_PORT=$DEFAULT_ADMIN_API_HOST_PORT
fi

# Construct Base URLs
BASE_URL="http://localhost:$API_GATEWAY_HOST_PORT"
ADMIN_API_URL="http://localhost:$ADMIN_API_HOST_PORT"
echo_info "Effective BASE_URL: $BASE_URL"
echo_info "Effective ADMIN_API_URL: $ADMIN_API_URL"

# --- Variables for New User and Bot ---
USER_EMAIL="testuser$(date +%s)@example.com"
USER_NAME="Test User $(date +%s)"
BOT_NAME="VexaFirstTestBot"
# PLATFORM and NATIVE_MEETING_ID (and optionally PASSCODE for Teams) set below from args or interactive input
PLATFORM=""
NATIVE_MEETING_ID=""
PASSCODE=""

# --- Function to stop the bot --- 
MEETING_ID_TO_STOP=""
USER_API_KEY_FOR_STOP=""

function stop_the_bot() {
    echo_info "\nStopping transcription client and bot..."
    
    # Stop the Python transcription client if it's running
    if [[ -n "$TRANSCRIPTION_PID" ]]; then
        echo_info "Stopping real-time transcription client (PID: $TRANSCRIPTION_PID)..."
        kill "$TRANSCRIPTION_PID" 2>/dev/null
        wait "$TRANSCRIPTION_PID" 2>/dev/null
    fi
    
    # Stop the bot
    if [[ -n "$MEETING_ID_TO_STOP" && -n "$USER_API_KEY_FOR_STOP" ]]; then
        echo_info "Stopping bot for meeting $MEETING_ID_TO_STOP..."
        STOP_RESPONSE=$(curl -s -X DELETE \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $USER_API_KEY_FOR_STOP" \
            "$BASE_URL/bots/$PLATFORM/$MEETING_ID_TO_STOP")
        
        if [[ "$JQ_INSTALLED" == true ]]; then
            STOP_MESSAGE=$(echo "$STOP_RESPONSE" | jq -r .message)
            echo_info "Stop bot response: $STOP_MESSAGE"
        else
            echo_info "Stop bot raw response: $STOP_RESPONSE"
        fi
    else
        echo_warn "Could not stop bot: Meeting ID or User API Key for stopping not set."
    fi
    echo_info "Exiting script."
    exit 0
}

# Trap SIGINT (Ctrl+C) and call stop_the_bot
trap stop_the_bot SIGINT SIGTERM

# --- 1. Create User ---
echo_info "Creating a new user: $USER_NAME ($USER_EMAIL)"
CREATE_USER_PAYLOAD=$(cat <<-END
{
  "email": "$USER_EMAIL",
  "name": "$USER_NAME",
  "max_concurrent_bots": 2
}
END
)

# Use ADMIN_API_URL for admin actions
CREATE_USER_RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Admin-API-Key: $ADMIN_TOKEN" \
    -d "$CREATE_USER_PAYLOAD" \
    "$ADMIN_API_URL/admin/users")

if [[ "$JQ_INSTALLED" == true ]]; then
    USER_ID=$(echo "$CREATE_USER_RESPONSE" | jq -r .id)
    USER_EMAIL_RES=$(echo "$CREATE_USER_RESPONSE" | jq -r .email)
    if [[ "$USER_ID" == "null" || -z "$USER_ID" ]]; then
        echo_error "Failed to create user. Response: $CREATE_USER_RESPONSE"
        exit 1
    fi
    echo_info "User created successfully. ID: $USER_ID, Email: $USER_EMAIL_RES"
else
    echo_info "Create user raw response: $CREATE_USER_RESPONSE"
    # Basic parsing if jq is not available (less reliable)
    USER_ID=$(echo "$CREATE_USER_RESPONSE" | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
    if [[ -z "$USER_ID" ]]; then
        echo_error "Failed to parse User ID from response. Ensure user was created via Admin Panel or install jq."
        exit 1
    fi
    echo_info "User likely created. Parsed ID: $USER_ID (Install jq for better parsing)"
fi

# --- 2. Create Token for User ---
echo_info "Creating API token for user ID: $USER_ID"
# According to vexa_client.py, this endpoint does not take a JSON payload.
# It's a POST request to /admin/users/{user_id}/tokens

# Use ADMIN_API_URL for admin actions
CREATE_TOKEN_RESPONSE=$(curl -s -X POST \
    -H "X-Admin-API-Key: $ADMIN_TOKEN" \
    "$ADMIN_API_URL/admin/users/$USER_ID/tokens")

if [[ "$JQ_INSTALLED" == true ]]; then
    USER_API_KEY=$(echo "$CREATE_TOKEN_RESPONSE" | jq -r .token)
    USER_API_KEY_FOR_STOP="$USER_API_KEY" # Set for trap
    if [[ "$USER_API_KEY" == "null" || -z "$USER_API_KEY" ]]; then
        echo_error "Failed to create token. Response: $CREATE_TOKEN_RESPONSE"
        exit 1
    fi
    echo_info "API Token created successfully: $USER_API_KEY"
else
    echo_info "Create token raw response: $CREATE_TOKEN_RESPONSE"
    # Basic parsing if jq is not available (less reliable)
    # Attempt to find a field named 'token' or 'api_key' as a fallback for non-jq users.
    # Prefer 'token' if both somehow existed, but focus on the more likely one based on recent findings.
    USER_API_KEY=$(echo "$CREATE_TOKEN_RESPONSE" | grep -o '"token":"[^"]*"' | grep -o ':"[^"]*"' | sed 's/:"//;s/"$//')
    if [[ -z "$USER_API_KEY" ]]; then # Fallback if 'token' field wasn't found, try 'api_key'
        USER_API_KEY=$(echo "$CREATE_TOKEN_RESPONSE" | grep -o '"api_key":"[^"]*"' | grep -o ':"[^"]*"' | sed 's/:"//;s/"$//')
    fi
    USER_API_KEY_FOR_STOP="$USER_API_KEY"
    if [[ -z "$USER_API_KEY" ]]; then
        echo_error "Failed to parse API Key from response. Ensure token was created or install jq."
        exit 1
    fi
    echo_info "API Token likely created. Parsed Key: $USER_API_KEY (Install jq for better parsing)"
fi

# --- 3. Select Platform and Get Meeting ID ---
# First, determine the platform
if [[ -n "$1" && "$1" =~ ^(google_meet|teams)$ ]]; then
    PLATFORM="$1"
    MEETING_ID="$2"
    echo_info "Using platform: $PLATFORM"
elif [[ -n "$1" ]]; then
    # Assume first arg is meeting ID if not a platform name, default to google_meet
    PLATFORM="google_meet"
    MEETING_ID="$1"
    echo_info "Defaulting to platform: $PLATFORM"
else
    # Interactive platform selection
    echo_info "Select meeting platform:"
    echo "  1) Google Meet"
    echo "  2) Microsoft Teams"
    read -p "Enter choice (1 or 2) [default: 1]: " PLATFORM_CHOICE
    PLATFORM_CHOICE=${PLATFORM_CHOICE:-1}

    case $PLATFORM_CHOICE in
        1)
            PLATFORM="google_meet"
            ;;
        2)
            PLATFORM="teams"
            ;;
        *)
            echo_error "Invalid platform choice: $PLATFORM_CHOICE"
            exit 1
            ;;
    esac
    echo_info "Selected platform: $PLATFORM"
fi

# Now get the meeting ID based on platform
MEETING_PASSCODE=""
if [[ -z "$MEETING_ID" ]]; then
    if [[ "$PLATFORM" == "google_meet" ]]; then
        # Interactive input for Google Meet
        while true; do
            read -p "Enter the Google Meet ID (e.g., abc-defg-hij): " MEETING_ID
            # Basic validation for meet ID format (3 letters - 4 letters - 3 letters)
            if [[ "$MEETING_ID" =~ ^[a-zA-Z]{3}-[a-zA-Z]{4}-[a-zA-Z]{3}$ ]]; then
                break
            else
                echo_warn "Invalid Google Meet ID format. Please use 'xxx-yyyy-zzz' (e.g., abc-defg-hij)."
            fi
        done
    elif [[ "$PLATFORM" == "teams" ]]; then
        # Interactive input for Microsoft Teams
        while true; do
            read -p "Enter the Teams Meeting ID (10-15 digits, e.g., 9399697580372): " MEETING_ID
            # Basic validation for Teams ID format (10-15 digits)
            if [[ "$MEETING_ID" =~ ^[0-9]{10,15}$ ]]; then
                break
            else
                echo_warn "Invalid Teams Meeting ID format. Please use 10-15 digits only."
            fi
        done
        # Optional: ask for passcode
        read -p "Enter Teams Meeting Passcode (optional, 8-20 chars): " MEETING_PASSCODE
    fi
fi

# Validate the meeting ID format based on platform
if [[ "$PLATFORM" == "google_meet" ]]; then
    if [[ "$MEETING_ID" =~ ^[a-zA-Z]{3}-[a-zA-Z]{4}-[a-zA-Z]{3}$ ]]; then
        MEETING_ID_TO_STOP="$MEETING_ID" # Set for trap
        echo_info "Valid Google Meet ID: $MEETING_ID"
    else
        echo_error "Invalid Google Meet ID format: $MEETING_ID. Expected format: xxx-yyyy-zzz"
        exit 1
    fi
elif [[ "$PLATFORM" == "teams" ]]; then
    if [[ "$MEETING_ID" =~ ^[0-9]{10,15}$ ]]; then
        MEETING_ID_TO_STOP="$MEETING_ID" # Set for trap
        echo_info "Valid Teams Meeting ID: $MEETING_ID"
        if [[ -n "$MEETING_PASSCODE" ]]; then
            echo_info "Teams passcode provided: $MEETING_PASSCODE"
        fi
    else
        echo_error "Invalid Teams Meeting ID format: $MEETING_ID. Expected 10-15 digits."
        exit 1
    fi
else
    echo_error "Unknown platform: $PLATFORM"
    exit 1
fi

# --- 4. Send Bot to Meeting ---
echo_info "Requesting bot '$BOT_NAME' for $PLATFORM meeting: $MEETING_ID"

# Build payload based on platform
if [[ "$PLATFORM" == "teams" && -n "$MEETING_PASSCODE" ]]; then
    # Teams with passcode
    REQUEST_BOT_PAYLOAD=$(cat <<-END
{
  "platform": "$PLATFORM",
  "native_meeting_id": "$MEETING_ID",
  "passcode": "$MEETING_PASSCODE",
  "bot_name": "$BOT_NAME"
}
END
)
else
    # Google Meet or Teams without passcode
    REQUEST_BOT_PAYLOAD=$(cat <<-END
{
  "platform": "$PLATFORM",
  "native_meeting_id": "$MEETING_ID",
  "bot_name": "$BOT_NAME"
}
END
)
fi

# Use BASE_URL for user actions
REQUEST_BOT_RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $USER_API_KEY" \
    -d "$REQUEST_BOT_PAYLOAD" \
    "$BASE_URL/bots")

MEETING_UUID=""
if [[ "$JQ_INSTALLED" == true ]]; then
    BOT_REQUEST_MSG=$(echo "$REQUEST_BOT_RESPONSE" | jq -r .message)
    MEETING_UUID=$(echo "$REQUEST_BOT_RESPONSE" | jq -r .meeting_uuid) # Assuming the response contains meeting_uuid or similar
    echo_info "Bot request response: $BOT_REQUEST_MSG"
    if [[ "$MEETING_UUID" == "null" || -z "$MEETING_UUID" ]]; then
       echo_warn "Could not get a meeting_uuid from bot request response. Transcript polling might rely on platform/native_meeting_id only."
       echo_warn "Bot request raw response: $REQUEST_BOT_RESPONSE"
    else
        echo_info "Meeting UUID: $MEETING_UUID"
    fi
else
    echo_info "Bot request raw response: $REQUEST_BOT_RESPONSE"
    # Attempt basic parse for meeting_uuid if needed by transcript endpoint, though client uses platform/native_id
fi

# Check if the bot request was successful enough to proceed (e.g. status code was 2xx)
# Curl with -s silences output but not errors. A more robust check would be on HTTP status code, but this is a simple script.
# We'll assume if USER_API_KEY is set and MEETING_ID is set, the request was likely sent.

# --- Wait for bot admission and provide user instructions ---
echo_info "Bot '$BOT_NAME' has been requested for $PLATFORM meeting: $MEETING_ID"
if [[ "$PLATFORM" == "google_meet" ]]; then
    echo_warn "Please admit the bot into your Google Meet session now."
elif [[ "$PLATFORM" == "teams" ]]; then
    echo_warn "Please admit the bot into your Microsoft Teams meeting now."
fi
echo_warn "Real-time transcription will begin shortly."

COUNTDOWN_SECONDS=10
echo_info "Starting real-time transcription in:"
for i in $(seq $COUNTDOWN_SECONDS -1 1); do
    echo -ne "$i... "
    sleep 1
done
echo "GO!"

# --- 5. Start Real-time Transcription ---
echo_info "Starting real-time WebSocket transcription for $PLATFORM/$MEETING_ID... Press Ctrl+C to stop."

# Python dependency already checked above

# Check if the real-time transcription script exists
SCRIPT_PATH="testing/ws_realtime_transcription.py"
if [[ ! -f "$SCRIPT_PATH" ]]; then
    echo_error "Real-time transcription script not found at $SCRIPT_PATH"
    exit 1
fi

# Construct WebSocket URL from base URL
WS_URL="${BASE_URL/http/ws}/ws"

echo_info "Using WebSocket URL: $WS_URL"
echo_info "Running real-time transcription client..."

# Run the Python real-time transcription client in background
# Use the virtual environment's Python to ensure websockets is available
if [ -f ".venv/bin/python" ]; then
    echo_info "Using virtual environment Python..."
    .venv/bin/python "$SCRIPT_PATH" \
        --api-base "$BASE_URL" \
        --ws-url "$WS_URL" \
        --api-key "$USER_API_KEY" \
        --platform "$PLATFORM" \
        --native-id "$MEETING_ID" &
else
    echo_error "Virtual environment not found at .venv/bin/python"
    echo_error "Please run 'make setup-env' first to create the virtual environment"
    exit 1
fi

# Store the PID for cleanup
TRANSCRIPTION_PID=$!

echo_info "Real-time transcription client started (PID: $TRANSCRIPTION_PID)"
echo_info "Press Ctrl+C to stop the transcription client and bot."

# Wait for the transcription client to complete or be interrupted
wait $TRANSCRIPTION_PID 