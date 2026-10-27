"""Marionette for robots: parts, not a framework.

- :class:`GatewayClient`: a reconnecting connection to a gateway (console or robot), safe to send from any thread.
- :class:`RobotLink`: a robot's own connection: its phone screen, its state, notices and JPEG frames.
- :class:`PhoneTracker` and :class:`Phone`: each phone's holds, drags, presses, values, pose and Stop.
- :mod:`marionette.teleop`: ``gate``, ``Clutch``, ``camera_frame``, ``JumpDetector``, ``PressTracker``, ``follow``, ``owners``.
- :mod:`marionette.video`: ``VideoPublisher``, WebRTC video from numpy frames (``pip install "marionette-sdk[video]"``).
- :mod:`marionette.gateway`: run the bundled gateway (``marionette-gateway``).
- :mod:`marionette.testing`: message builders, the real gateway on a free port, scriptable phones.
"""

from .address import PairingLink, format_code, gateway_url, normalize_code, parse_pairing_link
from .client import GatewayClient
from .phones import Drag, Hold, Phone, PhoneTracker, Pose
from .robot import RobotLink
from .teleop import Clutch, JumpDetector, PressTracker, camera_frame, follow, gate, owners

__version__ = "0.1.0"

__all__ = [
    "GatewayClient",
    "RobotLink",
    "PhoneTracker",
    "Phone",
    "Pose",
    "Hold",
    "Drag",
    "Clutch",
    "JumpDetector",
    "PressTracker",
    "gate",
    "camera_frame",
    "follow",
    "owners",
    "gateway_url",
    "parse_pairing_link",
    "normalize_code",
    "format_code",
    "PairingLink",
]
