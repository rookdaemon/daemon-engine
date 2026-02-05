#!/usr/bin/env python3
"""
Example monitoring script for daemon-engine observability API.

This script demonstrates how to use the observability endpoints to monitor
a running daemon-engine instance.
"""

import requests
import time
import sys
from datetime import datetime


class DaemonMonitor:
    def __init__(self, base_url: str, token: str = None):
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.headers = {}
        if token:
            self.headers['Authorization'] = f'Bearer {token}'
    
    def get_status(self):
        """Get daemon runtime status."""
        response = requests.get(f'{self.base_url}/status', headers=self.headers)
        response.raise_for_status()
        return response.json()
    
    def get_logs(self, lines: int = 50):
        """Get last N log entries."""
        response = requests.get(
            f'{self.base_url}/logs',
            params={'lines': lines},
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def get_history(self, limit: int = 10):
        """Get last N conversation messages."""
        response = requests.get(
            f'{self.base_url}/history',
            params={'limit': limit},
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def run_diagnostic(self, checks: list = None):
        """Run diagnostic checks."""
        body = {'checks': checks or []}
        response = requests.post(
            f'{self.base_url}/diagnostic',
            json=body,
            headers=self.headers
        )
        response.raise_for_status()
        return response.json()
    
    def check_health(self, verbose: bool = False):
        """Perform health check and return True if healthy."""
        try:
            # Get status
            status = self.get_status()
            
            if verbose:
                print(f"[{datetime.now().isoformat()}] Status Check:")
                print(f"  Status: {status['status']}")
                print(f"  Uptime: {status['uptime']}s")
                print(f"  Model: {status['model']}")
                print(f"  Version: {status['version']}")
            
            # Check recent logs for errors
            logs_data = self.get_logs(lines=50)
            logs = logs_data['logs']
            
            errors = [log for log in logs if log['level'] == 'error']
            warnings = [log for log in logs if log['level'] == 'warning']
            
            if errors:
                print(f"\n[{datetime.now().isoformat()}] Found {len(errors)} errors:")
                for error in errors[-5:]:  # Show last 5 errors
                    print(f"  {error['timestamp']}: [{error['category']}] {error['message']}")
            
            if warnings and verbose:
                print(f"\n[{datetime.now().isoformat()}] Found {len(warnings)} warnings:")
                for warning in warnings[-3:]:  # Show last 3 warnings
                    print(f"  {warning['timestamp']}: [{warning['category']}] {warning['message']}")
            
            # Run diagnostics
            if verbose:
                diagnostic = self.run_diagnostic()
                print(f"\n[{datetime.now().isoformat()}] Diagnostic Results:")
                for check_name, result in diagnostic['checks'].items():
                    print(f"  {check_name}: {result}")
            
            return len(errors) == 0
            
        except requests.exceptions.RequestException as e:
            print(f"[{datetime.now().isoformat()}] Health check failed: {e}")
            return False
    
    def monitor_loop(self, interval: int = 60, verbose: bool = False):
        """Run continuous monitoring loop."""
        print(f"Starting monitor (checking every {interval}s, verbose={verbose})")
        print(f"Monitoring: {self.base_url}")
        print("-" * 60)
        
        try:
            while True:
                healthy = self.check_health(verbose=verbose)
                
                if not healthy:
                    print(f"[{datetime.now().isoformat()}] WARNING: Health check failed!")
                    # Here you could send alerts, create incidents, etc.
                elif not verbose:
                    print(f"[{datetime.now().isoformat()}] Healthy")
                
                print()
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nMonitoring stopped")


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Monitor daemon-engine via observability API'
    )
    parser.add_argument(
        '--url',
        default='http://localhost:8080',
        help='Base URL of daemon-engine (default: http://localhost:8080)'
    )
    parser.add_argument(
        '--token',
        help='Bearer token for authentication'
    )
    parser.add_argument(
        '--interval',
        type=int,
        default=60,
        help='Check interval in seconds (default: 60)'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Show detailed information'
    )
    parser.add_argument(
        '--once',
        action='store_true',
        help='Run once and exit (no continuous monitoring)'
    )
    
    args = parser.parse_args()
    
    monitor = DaemonMonitor(args.url, args.token)
    
    if args.once:
        # Run single health check
        healthy = monitor.check_health(verbose=True)
        sys.exit(0 if healthy else 1)
    else:
        # Run continuous monitoring
        monitor.monitor_loop(interval=args.interval, verbose=args.verbose)


if __name__ == '__main__':
    main()
