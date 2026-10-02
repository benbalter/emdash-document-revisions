<?php
/**
 * Export WP Document Revisions documents, their full revision history, and
 * their files into a portable bundle for scripts/import-wpdr.mjs.
 *
 * Run on the WordPress server, where the document files are readable:
 *
 *   wp eval-file wpdr-export.php /path/to/bundle [--include-trash] [--allow-missing]
 *
 * Tested with WP Document Revisions 5.7. It calls the plugin's own API
 * (get_revision_indices, get_document), so it follows the plugin's
 * storage rules, including a document upload directory outside the web
 * root.
 *
 * The bundle is sensitive: export.json holds plaintext post passwords and
 * user emails, and files/ holds every private document. Keep it off shared
 * storage, never commit it, and delete it after importing.
 *
 * WordPress's own export (WXR) can't do this job: it leaves out post
 * revisions, which are WP Document Revisions' revision log, and its
 * attachment URLs point at files the plugin deliberately keeps private.
 *
 * Revisions keep WP Document Revisions' numbering (1-indexed over the
 * document's non-autosave revisions, oldest first), so imported documents
 * answer the same /documents/…/slug-revision-N.ext links. Each distinct
 * attachment is copied once; revisions that didn't change the file (title,
 * description, or note edits) reference the same copy.
 *
 * The bundle is a directory:
 *   export.json   documents, revisions, authors, visibility, workflow states
 *   files/        one copy per attachment, named att-<id><ext>
 *
 * Requires WP Document Revisions to be active (it uses its API via $wpdr).
 *
 * @package emdash-document-revisions
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit( 'Run with: wp eval-file wpdr-export.php <bundle-dir>' . PHP_EOL );
}

// `wp eval-file` passes trailing arguments in $args.
$wpdr_export_args = isset( $args ) && is_array( $args ) ? $args : array();
$wpdr_export_dir  = '';
$include_trash    = false;
$allow_missing    = false;
foreach ( $wpdr_export_args as $wpdr_export_arg ) {
	if ( '--include-trash' === $wpdr_export_arg ) {
		$include_trash = true;
	} elseif ( '--allow-missing' === $wpdr_export_arg ) {
		$allow_missing = true;
	} elseif ( '' === $wpdr_export_dir ) {
		$wpdr_export_dir = $wpdr_export_arg;
	}
}

/**
 * Print a line through WP-CLI when available, else stdout.
 *
 * @param string $message the message.
 * @param bool   $error   whether this is fatal.
 */
function wpdr_export_log( string $message, bool $error = false ): void {
	if ( class_exists( 'WP_CLI' ) ) {
		$error ? WP_CLI::error( $message ) : WP_CLI::log( $message );
		return;
	}
	echo $message . PHP_EOL; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	if ( $error ) {
		exit( 1 );
	}
}

global $wpdr;
foreach ( array( 'get_revision_indices', 'get_document' ) as $wpdr_method ) {
	if ( empty( $wpdr ) || ! method_exists( $wpdr, $wpdr_method ) ) {
		wpdr_export_log( "WP Document Revisions is not active, or too old (no \$wpdr->$wpdr_method()).", true );
	}
}
if ( '' === $wpdr_export_dir ) {
	wpdr_export_log( 'Usage: wp eval-file wpdr-export.php <bundle-dir> [--include-trash]', true );
}
if ( ! wp_mkdir_p( $wpdr_export_dir . '/files' ) ) {
	wpdr_export_log( "Can't create $wpdr_export_dir/files", true );
}

/**
 * Author details, keyed so the importer can match EmDash users by email.
 *
 * @param int $user_id the WordPress user ID.
 * @return array<string, string|int>|null
 */
function wpdr_export_user( int $user_id ): ?array {
	$user = get_userdata( $user_id );
	if ( ! $user ) {
		return null;
	}
	return array(
		'id'    => (int) $user->ID,
		'login' => $user->user_login,
		'email' => $user->user_email,
		'name'  => $user->display_name,
	);
}

/**
 * MySQL GMT datetime to ISO 8601.
 *
 * @param string $gmt the GMT datetime.
 * @return string|null
 */
function wpdr_export_iso( string $gmt ): ?string {
	if ( '' === $gmt || '0000-00-00 00:00:00' === $gmt ) {
		return null;
	}
	return gmdate( 'Y-m-d\TH:i:s\Z', (int) strtotime( $gmt . ' UTC' ) );
}

/**
 * Copy an attachment's file into the bundle once and describe it.
 *
 * @param WP_Post $attachment the attachment.
 * @param string  $slug       the document slug, used for the file name.
 * @param string  $dir        the bundle directory.
 * @return array<string, string|int>|null
 */
function wpdr_export_file( WP_Post $attachment, string $slug, string $dir ): ?array {
	global $wpdr_export_missing;
	static $copied = array();
	if ( isset( $copied[ $attachment->ID ] ) ) {
		return $copied[ $attachment->ID ];
	}

	$source = get_attached_file( $attachment->ID );
	if ( ! $source || ! is_readable( $source ) ) {
		if ( ! isset( $wpdr_export_missing[ $attachment->ID ] ) ) {
			wpdr_export_log( "  ! attachment {$attachment->ID}: file missing ($source)" );
		}
		$wpdr_export_missing[ $attachment->ID ] = true;
		return null;
	}

	$ext  = strtolower( (string) pathinfo( $source, PATHINFO_EXTENSION ) );
	$ext  = '' === $ext ? '' : '.' . $ext;
	$name = 'att-' . $attachment->ID . $ext;
	if ( ! copy( $source, $dir . '/files/' . $name ) ) {
		wpdr_export_log( "  ! attachment {$attachment->ID}: copy failed" );
		return null;
	}

	$copied[ $attachment->ID ] = array(
		'path'         => 'files/' . $name,
		'attachmentId' => (int) $attachment->ID,
		// Uploads are renamed to an MD5 on upload, so the original name is
		// gone; WP Document Revisions serves files as slug + extension too.
		'filename'     => $slug . $ext,
		'contentType'  => $attachment->post_mime_type ? $attachment->post_mime_type : 'application/octet-stream',
		'size'         => (int) filesize( $source ),
		'sha256'       => hash_file( 'sha256', $source ),
	);
	return $copied[ $attachment->ID ];
}

$statuses = array( 'publish', 'private', 'draft', 'pending', 'future' );
if ( $include_trash ) {
	$statuses[] = 'trash';
}

// Straight from the table: `wp eval-file` runs with no user, and WP Document
// Revisions drops documents the current user can't read (private ones)
// from WP_Query results, which suppress_filters doesn't prevent.
global $wpdb;
$placeholders = implode( ', ', array_fill( 0, count( $statuses ), '%s' ) );
$ids          = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	$wpdb->prepare(
		"SELECT ID FROM {$wpdb->posts} WHERE post_type = 'document' AND post_status IN ($placeholders) ORDER BY ID ASC", // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$statuses
	)
);

$documents           = array();
$files               = 0;
$wpdr_export_missing = array();

foreach ( $ids as $doc_id ) {
	$doc = get_post( $doc_id );
	if ( ! $doc ) {
		continue;
	}
	$slug = $doc->post_name ? $doc->post_name : sanitize_title( $doc->post_title, 'document-' . $doc->ID );
	// Trashing renames the slug to "slug__trashed" and keeps the original here.
	if ( 'trash' === $doc->post_status ) {
		$desired = get_post_meta( $doc->ID, '_wp_desired_post_slug', true );
		$slug    = $desired ? $desired : preg_replace( '/__trashed(-\d+)?$/', '', $slug );
	}

	// Description: the document content minus the <!-- WPDR n --> marker.
	$description = trim( (string) preg_replace( '/<!--\s*WPDR\s*\d+\s*-->/i', '', (string) $doc->post_content ) );
	if ( is_numeric( $description ) ) {
		$description = ''; // Pre-3.4 content held only the attachment ID.
	}

	$revisions = array();
	foreach ( $wpdr->get_revision_indices( (int) $doc->ID ) as $n => $revision_id ) {
		$revision   = get_post( $revision_id );
		$attachment = $revision ? $wpdr->get_document( $revision_id ) : false;
		if ( ! $revision || ! $attachment ) {
			continue; // A save before any file was attached.
		}
		$file = wpdr_export_file( $attachment, $slug, $wpdr_export_dir );
		if ( ! $file ) {
			continue;
		}
		$revisions[] = array(
			'n'      => (int) $n,
			'wpId'   => (int) $revision->ID,
			'date'   => wpdr_export_iso( $revision->post_date_gmt ),
			'author' => wpdr_export_user( (int) $revision->post_author ),
			'note'   => html_entity_decode( (string) $revision->post_excerpt, ENT_QUOTES ),
			'file'   => $file,
		);
	}

	// Sites with revisions disabled still have the current file.
	if ( ! $revisions ) {
		$attachment = $wpdr->get_document( $doc->ID );
		$file       = $attachment ? wpdr_export_file( $attachment, $slug, $wpdr_export_dir ) : null;
		if ( $file ) {
			$revisions[] = array(
				'n'      => 1,
				'wpId'   => (int) $doc->ID,
				'date'   => wpdr_export_iso( $doc->post_modified_gmt ),
				'author' => wpdr_export_user( (int) $doc->post_author ),
				'note'   => html_entity_decode( (string) $doc->post_excerpt, ENT_QUOTES ),
				'file'   => $file,
			);
		}
	}

	$states = wp_get_object_terms( $doc->ID, 'workflow_state' );
	$states = is_wp_error( $states ) ? array() : $states;

	$documents[] = array(
		'wpId'           => (int) $doc->ID,
		'slug'           => $slug,
		// Not get_the_title(): outside wp-admin it prefixes "Private: " / "Protected: ".
		'title'          => html_entity_decode( $doc->post_title, ENT_QUOTES ),
		'description'    => $description,
		'status'         => $doc->post_status,
		'password'       => (string) $doc->post_password,
		'date'           => wpdr_export_iso( $doc->post_date_gmt ),
		'modified'       => wpdr_export_iso( $doc->post_modified_gmt ),
		'author'         => wpdr_export_user( (int) $doc->post_author ),
		'permalink'      => get_permalink( $doc ),
		'workflowStates' => array_map(
			static function ( $term ) {
				return array(
					'slug' => $term->slug,
					'name' => $term->name,
				);
			},
			$states
		),
		'revisions'      => $revisions,
	);

	$files += count( array_unique( array_column( array_column( $revisions, 'file' ), 'attachmentId' ) ) );
	wpdr_export_log( sprintf( '%s (%s): %d revisions', $slug, $doc->post_status, count( $revisions ) ) );
}

$export = array(
	'format'     => 'wpdr-export',
	'version'    => 1,
	'exportedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
	'site'       => home_url(),
	'wpdrVersion' => defined( 'WPDR_VERSION' ) ? WPDR_VERSION : null,
	'documents'  => $documents,
);

file_put_contents( // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
	$wpdr_export_dir . '/export.json',
	wp_json_encode( $export, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE )
);

wpdr_export_log( sprintf( 'Exported %d documents and %d files to %s', count( $documents ), $files, $wpdr_export_dir ) );

// A missing file drops that revision; the importer would otherwise treat the
// document as complete. Fail loudly unless the caller accepts the gaps.
if ( $wpdr_export_missing ) {
	$message = sprintf( '%d attachment file(s) were missing; those revisions are not in the bundle.', count( $wpdr_export_missing ) );
	if ( $allow_missing ) {
		wpdr_export_log( "Warning: $message" );
	} else {
		wpdr_export_log( "$message Fix the files, or re-run with --allow-missing to export without them.", true );
	}
}
