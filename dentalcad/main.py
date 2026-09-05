"""
DentalCAD — Main Entry Point
Run with: python main.py
"""

import sys
import os

# Ensure the dentalcad package directory is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont

from theme import DARK_STYLESHEET
from ui.splash_screen import SplashScreen
from ui.main_window import MainWindow


def main():
    # High-DPI support
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setApplicationName("DentalCAD")
    app.setApplicationVersion("1.0.0")
    app.setOrganizationName("DentalCAD")

    # Set default font
    font = QFont("Segoe UI", 10)
    app.setFont(font)

    # Apply global dark theme
    app.setStyleSheet(DARK_STYLESHEET)

    # Create main window (don't show yet)
    window = MainWindow()

    # Show splash screen, then reveal main window
    splash = SplashScreen()
    splash.show_and_close(window, delay_ms=2500)

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
